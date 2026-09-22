import assert from "node:assert/strict";
import test from "node:test";
import { verifiedIdentityHash } from "../src/index.ts";

test("invoice identity requires a labeled exact token, not a recurring account", () => {
  const identity = { issuer: "Acme Agua", reference: "INV-1234" };
  assert.ok(
    verifiedIdentityHash(identity, ["Acme Agua Factura INV-1234 COP 50"]),
  );
  assert.ok(
    verifiedIdentityHash(identity, ["Acme Agua Factura INV-1234, COP 50"]),
  );
  assert.equal(
    verifiedIdentityHash(identity, ["Acme Agua Cuenta INV-1234 COP 50"]),
    null,
  );
  assert.equal(
    verifiedIdentityHash(identity, ["Acme Agua Factura INV-12345 COP 50"]),
    null,
  );
  for (const suffix of ["-2026", "/02", "_A", ".B"]) {
    assert.equal(
      verifiedIdentityHash(identity, [
        `Acme Agua Factura INV-1234${suffix} COP 50`,
      ]),
      null,
    );
  }
  assert.equal(
    verifiedIdentityHash(identity, ["Otro Acme AguaX Factura INV-1234"]),
    null,
  );
});
