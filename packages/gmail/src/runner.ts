import type { Pool } from "pg";
import { SourceRepository } from "@crashmemory/db";
import { S3ObjectStorage } from "@crashmemory/runtime";
import { CredentialCipher } from "@crashmemory/security";
import {
  GmailHistoryExpiredError,
  GmailReauthRequiredError,
  GmailSyncService,
  GoogleGmailRemote,
  refreshGoogleAccessToken,
} from "./index.ts";
import { PostgresGmailPersistence } from "./postgres.ts";

export interface GmailSyncRunnerConfig {
  clientId: string;
  clientSecret: string;
  pubsubTopic: string;
  credentialCipher: CredentialCipher;
  objectStorage: ConstructorParameters<typeof S3ObjectStorage>[0];
  historicalLimit?: number;
}

interface StoredGmailCredential {
  refreshToken?: unknown;
}

/** Invoked by the scheduler for wakeups, polling fallback and daily watch renewal. */
export class PostgresGmailSyncRunner {
  private readonly storage: S3ObjectStorage;

  constructor(
    private readonly pool: Pool,
    private readonly config: GmailSyncRunnerConfig,
  ) {
    this.storage = new S3ObjectStorage(config.objectStorage);
  }

  async runOnce(): Promise<number> {
    await this.storage.ensureBucket();
    const sources = new SourceRepository(this.pool);
    const connections = await sources.listActiveGmailConnections();
    let synchronized = 0;
    for (const connection of connections) {
      const persistence = new PostgresGmailPersistence(
        this.pool,
        connection.userId,
        connection.id,
        this.storage,
      );
      try {
        const encrypted = await sources.getCredential(
          connection.userId,
          connection.id,
        );
        if (!encrypted) throw new GmailReauthRequiredError();
        const parsed = JSON.parse(
          this.config.credentialCipher.decrypt(
            encrypted,
            `${connection.userId}:${connection.id}`,
          ),
        ) as StoredGmailCredential;
        if (
          typeof parsed.refreshToken !== "string" ||
          parsed.refreshToken.length === 0
        ) {
          throw new GmailReauthRequiredError();
        }
        const refreshed = await refreshGoogleAccessToken({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          refreshToken: parsed.refreshToken,
        });
        const remote = new GoogleGmailRemote(
          refreshed.accessToken,
          this.config.pubsubTopic,
        );
        const sync = new GmailSyncService(
          remote,
          persistence,
          this.config.historicalLimit,
        );
        try {
          if (connection.cursorValue)
            await sync.incremental(connection.cursorValue);
          else await sync.bootstrap();
        } catch (error) {
          if (!(error instanceof GmailHistoryExpiredError)) throw error;
          // 404 is explicit and bounded: re-run the configured archive followed
          // by catch-up; it never substitutes an arbitrary full mailbox import.
          await sync.bootstrap("resync");
        }
        const renewBefore = Date.now() + 48 * 60 * 60 * 1000;
        if (
          !connection.watchExpirationAt ||
          connection.watchExpirationAt.getTime() < renewBefore
        ) {
          await sync.renewWatch();
        }
        await sources.clearGmailPushNotification(connection.id);
        synchronized += 1;
      } catch (error) {
        if (error instanceof GmailReauthRequiredError) {
          await persistence.recordSyncFailure("reauth_required");
        }
        // Leave the durable wakeup in place after every failure. The next poll
        // retries a safe incremental sync from the last confirmed cursor.
      }
    }
    return synchronized;
  }
}
