"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Envelope<T> = { data: T; meta?: { nextCursor?: string | null } };
type Obligation = {
  obligationId: string;
  id: string;
  revision: number;
  state: string;
  title: string;
  amount: { amount: string; currency: string };
  due: { kind: string; date?: string; at?: string; timeZone?: string } | null;
};
type Evidence = {
  id: string;
  kind: string;
  page: number | null;
  quote: string;
  contentSha256: string;
  url: string;
};
type Conflict = {
  id: string;
  reason: string;
  state: string;
  proposal: unknown;
  createdAt: string;
};
type Detail = {
  id: string;
  state: string;
  currentVersionId: string;
  updatedAt: string;
  versions: Array<Obligation & { evidence: Evidence[] }>;
  protectedFields: Array<{ field: string; value: unknown }>;
  conflicts: Conflict[];
};
type Gmail = {
  id: string;
  email: string;
  state: string;
  lastSyncAt: string | null;
  errorCode: string | null;
};
type Reminder = {
  id: string;
  obligationId?: string;
  scheduledFor: string;
  kind?: string;
  state?: string;
};
type Attempt = {
  id: string;
  attemptNumber: number;
  preparedAt: string;
  outcome?: "sent" | "failed" | "unknown";
  errorCode?: string | null;
};
type Review = {
  id: string;
  sourceItemRevisionId: string;
  state: string;
  reasonCode?: string;
  createdAt?: string;
};
const labels: Record<string, string> = {
  candidate: "Por confirmar",
  confirmed: "Confirmada",
  conflict: "Conflicto",
  paid: "Pagada",
  discarded: "Descartada",
  manual_review: "Revisión manual",
  failed: "Fallida",
};
const dueText = (due: Obligation["due"]) =>
  !due
    ? "Sin fecha"
    : due.kind === "civil_date" && due.date
      ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium" }).format(
          new Date(`${due.date}T12:00:00`),
        )
      : due.at
        ? `${new Intl.DateTimeFormat("es-CO", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: due.timeZone,
          }).format(new Date(due.at))} (${due.timeZone})`
        : "Fecha no disponible";
const money = (value: Obligation["amount"]) =>
  `${value.currency} ${value.amount}`;
const reviewReason = (code?: string) =>
  ({
    pdf_requires_manual_review:
      "El PDF necesita revisión manual (por ejemplo, está escaneado o protegido).",
    invalid_evidence: "La evidencia extraída no pudo validarse.",
    extraction_failed: "La extracción falló y debe revisarse.",
  })[code ?? ""] ?? "La extracción quedó bloqueada para revisión manual.";

export default function HomePage() {
  const sessionGeneration = useRef(0);
  const [csrf, setCsrf] = useState("");
  const [user, setUser] = useState<{ email: string; timeZone: string } | null>(
    null,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [gmail, setGmail] = useState<Gmail[]>([]);
  const [telegram, setTelegram] = useState<{
    linked?: boolean;
    state?: string;
    linkedAt?: string | null;
  } | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [attempts, setAttempts] = useState<Record<string, Attempt[]>>({});
  const [view, setView] = useState<"obligations" | "connections" | "alerts">(
    "obligations",
  );
  const clearSession = useCallback(() => {
    sessionGeneration.current += 1;
    setUser(null);
    setCsrf("");
    setSelected(null);
    setObligations([]);
    setGmail([]);
    setTelegram(null);
    setReviews([]);
    setReminders([]);
    setAttempts({});
    setMessage("");
    sessionStorage.removeItem("crashmemory.session");
  }, []);
  const isStale = (error: unknown): boolean =>
    error instanceof Error && error.name === "CrashMemoryStaleResponse";
  const staleResponse = () => {
    const error = new Error("Obsolete response");
    error.name = "CrashMemoryStaleResponse";
    return error;
  };
  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const generation = sessionGeneration.current;
      let response: Response;
      try {
        response = await fetch(path, {
          ...init,
          credentials: "include",
          headers: {
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...(init?.headers ?? {}),
          },
        });
      } catch (error) {
        if (generation !== sessionGeneration.current) throw staleResponse();
        throw error;
      }
      if (generation !== sessionGeneration.current) throw staleResponse();
      if (response.status === 401) {
        clearSession();
        setLoginError("Tu sesión terminó. Inicia sesión de nuevo.");
        const error = new Error(
          "Tu sesión terminó. Inicia sesión de nuevo.",
        ) as Error & { status?: number };
        error.status = 401;
        throw error;
      }
      const payload = (await response
        .json()
        .catch(() => ({}))) as Envelope<T> & { error?: { message?: string } };
      if (generation !== sessionGeneration.current) throw staleResponse();
      if (!response.ok) {
        const error = new Error(
          payload.error?.message ?? "No se pudo completar la solicitud.",
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return payload.data;
    },
    [clearSession],
  );
  const requestPage = useCallback(
    async <T,>(path: string): Promise<Envelope<T>> => {
      const generation = sessionGeneration.current;
      let response: Response;
      try {
        response = await fetch(path, { credentials: "include" });
      } catch (error) {
        if (generation !== sessionGeneration.current) throw staleResponse();
        throw error;
      }
      if (generation !== sessionGeneration.current) throw staleResponse();
      if (response.status === 401) {
        clearSession();
        setLoginError("Tu sesión terminó. Inicia sesión de nuevo.");
        const error = new Error(
          "Tu sesión terminó. Inicia sesión de nuevo.",
        ) as Error & { status?: number };
        error.status = 401;
        throw error;
      }
      const payload = (await response
        .json()
        .catch(() => ({}))) as Envelope<T> & { error?: { message?: string } };
      if (generation !== sessionGeneration.current) throw staleResponse();
      if (!response.ok)
        throw new Error(
          payload.error?.message ?? "No se pudo cargar la página.",
        );
      return payload;
    },
    [clearSession],
  );
  async function allPages<T>(path: string, limit: number): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | null | undefined;
    do {
      const separator = path.includes("?") ? "&" : "?";
      const page = await requestPage<T[]>(
        `${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      result.push(...page.data);
      cursor = page.meta?.nextCursor;
    } while (cursor);
    return result;
  }
  const load = useCallback(async () => {
    const [list, gmailState, telegramState, reviewState, reminderState] =
      await Promise.all([
        allPages<Obligation>("/api/v1/obligations", 100),
        request<Gmail[]>("/api/v1/gmail"),
        request<{ linked?: boolean; state?: string; linkedAt?: string | null }>(
          "/api/v1/telegram/status",
        ),
        allPages<Review>("/api/v1/extraction/reviews", 25),
        allPages<Reminder>("/api/v1/reminders", 25),
      ]);
    setObligations(list);
    setGmail(gmailState);
    setTelegram(telegramState);
    setReviews(reviewState);
    setReminders(reminderState);
  }, [request, requestPage]);
  useEffect(() => {
    const saved = sessionStorage.getItem("crashmemory.session");
    if (saved) {
      try {
        const state = JSON.parse(saved) as {
          csrf: string;
          user: { email: string; timeZone: string };
        };
        if (state.csrf && state.user) {
          setCsrf(state.csrf);
          setUser(state.user);
        }
      } catch {
        sessionStorage.removeItem("crashmemory.session");
      }
    }
  }, []);
  useEffect(() => {
    if (user)
      void load().catch((error: Error) => {
        if (isStale(error)) return;
        sessionStorage.removeItem("crashmemory.session");
        setMessage(error.message);
      });
  }, [user, load]);
  async function login(event: FormEvent) {
    event.preventDefault();
    sessionGeneration.current += 1;
    setBusy(true);
    setLoginError("");
    try {
      const result = await request<{
        user: { email: string; timeZone: string };
        csrfToken: string;
      }>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setCsrf(result.csrfToken);
      setUser(result.user);
      sessionStorage.setItem(
        "crashmemory.session",
        JSON.stringify({ csrf: result.csrfToken, user: result.user }),
      );
      setPassword("");
    } catch (error) {
      if (isStale(error)) return;
      setLoginError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setSelected(await request<Detail>(`/api/v1/obligations/${id}`));
  }
  async function openSafely(id: string) {
    try {
      await open(id);
    } catch (error) {
      if (!isStale(error)) setMessage((error as Error).message);
    }
  }
  async function mutate(
    action: string,
    changes?: unknown,
    conflictId?: string,
    resolution?: string,
  ) {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const body = {
        expectedVersion: selected.versions[0]?.revision,
        ...(changes ? { changes } : {}),
        ...(conflictId ? { conflictId, resolution } : {}),
      };
      await request(`/api/v1/obligations/${selected.id}/${action}`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify(body),
      });
      await open(selected.id);
      await load();
      setMessage("Cambio guardado.");
    } catch (error) {
      if (isStale(error)) return;
      const typed = error as Error & { status?: number };
      if (typed.status === 409) {
        await open(selected.id);
        setMessage(
          "La obligación cambió en otra sesión. Se actualizó para que revises antes de intentar de nuevo.",
        );
      } else setMessage(typed.message);
    } finally {
      setBusy(false);
    }
  }
  async function connectGmail() {
    try {
      const result = await request<{ authorizationUrl: string }>(
        "/api/v1/gmail/connect",
        {
          method: "POST",
          headers: { "X-CSRF-Token": csrf },
          body: JSON.stringify({ redirectPath: "/" }),
        },
      );
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      if (isStale(error)) return;
      setMessage((error as Error).message);
    }
  }
  async function linkTelegram() {
    try {
      const result = await request<{ startCommand: string; expiresAt: string }>(
        "/api/v1/telegram/link",
        { method: "POST", headers: { "X-CSRF-Token": csrf }, body: "{}" },
      );
      setMessage(
        `En Telegram envía ${result.startCommand}. Código válido hasta ${new Date(result.expiresAt).toLocaleString("es-CO")}.`,
      );
    } catch (error) {
      if (isStale(error)) return;
      setMessage((error as Error).message);
    }
  }
  async function disconnectGmail(connectionId: string) {
    try {
      await request("/api/v1/lifecycle/gmail/disconnect", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: JSON.stringify({ connectionId }),
      });
      await load();
      setMessage("Gmail desconectado. Los datos históricos se conservaron.");
    } catch (error) {
      if (isStale(error)) return;
      const typed = error as Error & { status?: number };
      setMessage(
        typed.status === 404 ? "Acción no disponible todavía." : typed.message,
      );
    }
  }
  async function unlinkTelegram() {
    try {
      await request("/api/v1/lifecycle/telegram/unlink", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: "{}",
      });
      await load();
      setMessage("Telegram desvinculado.");
    } catch (error) {
      if (isStale(error)) return;
      const typed = error as Error & { status?: number };
      setMessage(
        typed.status === 404 ? "Acción no disponible todavía." : typed.message,
      );
    }
  }
  async function showAttempts(reminderId: string) {
    try {
      const values = await allPages<Attempt>(
        `/api/v1/reminders/${reminderId}/attempts`,
        25,
      );
      setAttempts((previous) => ({ ...previous, [reminderId]: values }));
    } catch (error) {
      if (isStale(error)) return;
      setMessage((error as Error).message);
    }
  }
  async function logout() {
    try {
      await request("/api/v1/auth/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": csrf },
        body: "{}",
      });
      setMessage("Sesión cerrada.");
      clearSession();
    } catch (error) {
      const typed = error as Error & { status?: number };
      if (isStale(error)) return;
      if (typed.status === 401) clearSession();
      else setMessage(typed.message);
    }
  }
  if (!user)
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="login-title">
          <p className="eyebrow">MEMORIA DE OBLIGACIONES</p>
          <h1 id="login-title">CrashMemory</h1>
          <p className="lead">
            Reúne tus correos, fechas y evidencias en un solo lugar.
          </p>
          <form onSubmit={login}>
            <label htmlFor="email">
              Correo
              <input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label htmlFor="password">
              Contraseña
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Entrando…" : "Entrar"}
            </button>
            {loginError && (
              <p className="error" role="alert">
                {loginError}
              </p>
            )}
          </form>
          <p className="muted">
            Usa el usuario creado por <code>pnpm db:seed</code>.
          </p>
        </section>
      </main>
    );
  const current = selected?.versions[0];
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">CRASHMEMORY</p>
          <h1>Mis obligaciones</h1>
        </div>
        <div className="account">
          <span>{user.email}</span>
          <button className="button-quiet" onClick={() => void logout()}>
            Cerrar sesión
          </button>
        </div>
      </header>
      <nav className="tabs" aria-label="Secciones">
        <button
          className={view === "obligations" ? "active" : ""}
          onClick={() => setView("obligations")}
        >
          Obligaciones
        </button>
        <button
          className={view === "connections" ? "active" : ""}
          onClick={() => setView("connections")}
        >
          Conexiones
        </button>
        <button
          className={view === "alerts" ? "active" : ""}
          onClick={() => setView("alerts")}
        >
          Avisos
        </button>
      </nav>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {view === "connections" ? (
        <Connections
          gmail={gmail}
          telegram={telegram}
          onGmail={connectGmail}
          onTelegram={linkTelegram}
          onDisconnect={disconnectGmail}
          onUnlink={unlinkTelegram}
        />
      ) : view === "alerts" ? (
        <Alerts
          reminders={reminders}
          attempts={attempts}
          onAttempts={showAttempts}
        />
      ) : (
        <div className="workspace">
          <section className="panel list-panel" aria-labelledby="list-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">SEGUIMIENTO</p>
                <h2 id="list-title">Obligaciones</h2>
              </div>
              <span className="count">{obligations.length}</span>
            </div>
            {obligations.length === 0 ? (
              <div className="empty">
                <h3>Aún no hay obligaciones</h3>
                <p>
                  Conecta Gmail para importar correos y detectar fechas de pago.
                </p>
                <button onClick={() => setView("connections")}>
                  Conectar Gmail
                </button>
              </div>
            ) : (
              <ul className="obligation-list">
                {obligations.map((item) => (
                  <li key={item.obligationId}>
                    <button
                      className={
                        selected?.id === item.obligationId
                          ? "obligation selected"
                          : "obligation"
                      }
                      onClick={() => void openSafely(item.obligationId)}
                    >
                      <span>
                        <strong>{item.title}</strong>
                        <small>{dueText(item.due)}</small>
                      </span>
                      <span className="obligation-meta">
                        <b>{money(item.amount)}</b>
                        <em className={`state ${item.state}`}>
                          {labels[item.state] ?? item.state}
                        </em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {reviews.length > 0 && (
              <div className="review-box">
                <h3>Revisiones pendientes</h3>
                {reviews.map((review) => (
                  <p key={review.id}>
                    <strong>{reviewReason(review.reasonCode)}</strong>
                    <br />
                    <small>
                      Fuente: {review.sourceItemRevisionId} · Estado:{" "}
                      {labels[review.state] ?? review.state}
                    </small>
                  </p>
                ))}
              </div>
            )}
          </section>
          <section
            className="panel detail-panel"
            aria-labelledby="detail-title"
          >
            {!selected ? (
              <div className="empty detail-empty">
                <span className="spark" aria-hidden="true">
                  ✦
                </span>
                <h2 id="detail-title">Selecciona una obligación</h2>
                <p>Consulta su historial, evidencia y acciones desde aquí.</p>
              </div>
            ) : (
              <DetailView
                key={`${selected.id}:${selected.currentVersionId}`}
                detail={selected}
                current={current}
                busy={busy}
                onMutate={mutate}
                request={request}
              />
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function Connections({
  gmail,
  telegram,
  onGmail,
  onTelegram,
  onDisconnect,
  onUnlink,
}: {
  gmail: Gmail[];
  telegram: {
    linked?: boolean;
    state?: string;
    linkedAt?: string | null;
  } | null;
  onGmail: () => void;
  onTelegram: () => void;
  onDisconnect: (connectionId: string) => void;
  onUnlink: () => void;
}) {
  return (
    <section className="connections">
      <div className="panel connection-card">
        <p className="eyebrow">FUENTE</p>
        <h2>Gmail</h2>
        <p>
          Importa mensajes autorizados para detectar obligaciones y conservar su
          evidencia.
        </p>
        {gmail.length ? (
          gmail.map((item) => (
            <div className="connection-status" key={item.id}>
              <strong>{item.email}</strong>
              <span className={`state ${item.state}`}>
                {labels[item.state] ?? item.state}
              </span>
              <small>
                {item.lastSyncAt
                  ? `Última sincronización: ${new Date(item.lastSyncAt).toLocaleString("es-CO")}`
                  : "Aún no sincronizado"}
              </small>
              {item.errorCode && (
                <small className="error">Estado: {item.errorCode}</small>
              )}
              <button
                className="button-quiet"
                onClick={() => onDisconnect(item.id)}
              >
                Desconectar Gmail
              </button>
            </div>
          ))
        ) : (
          <p className="muted">No hay una cuenta conectada.</p>
        )}
        <button onClick={onGmail}>Conectar Gmail</button>
        <p className="muted">
          El callback vuelve a esta web después de autorizar en Google.
        </p>
      </div>
      <div className="panel connection-card">
        <p className="eyebrow">AVISOS</p>
        <h2>Telegram</h2>
        <p>
          Vincula tu chat para recibir recordatorios cuando estén habilitados.
        </p>
        <div className="connection-status">
          <strong>
            {telegram?.linked || telegram?.state === "linked"
              ? "Vinculado"
              : "Sin vincular"}
          </strong>
          <small>
            {telegram?.linkedAt
              ? `Vinculado: ${new Date(telegram.linkedAt).toLocaleString("es-CO")}`
              : "No se guarda el contenido de los mensajes."}
          </small>
        </div>
        <button onClick={onTelegram}>Generar código de vínculo</button>
        <button className="button-quiet" onClick={onUnlink}>
          Desvincular Telegram
        </button>
      </div>
    </section>
  );
}

function Alerts({
  reminders,
  attempts,
  onAttempts,
}: {
  reminders: Reminder[];
  attempts: Record<string, Attempt[]>;
  onAttempts: (id: string) => void;
}) {
  const outcomeLabel = (outcome?: string) =>
    outcome === "sent"
      ? "Enviado"
      : outcome === "failed"
        ? "Fallido"
        : outcome === "unknown"
          ? "Resultado incierto"
          : "Pendiente";
  return (
    <section className="panel alerts-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">NOTIFICACIONES</p>
          <h2>Avisos programados</h2>
        </div>
        <span className="count">{reminders.length}</span>
      </div>
      {reminders.length === 0 ? (
        <div className="empty">
          <h3>No hay avisos</h3>
          <p>
            Los recordatorios aparecen cuando una obligación confirmada tiene
            política automática activa.
          </p>
        </div>
      ) : (
        <ul className="reminder-list">
          {reminders.map((reminder) => (
            <li className="reminder-item" key={reminder.id}>
              <div>
                <strong>{reminder.kind ?? "Recordatorio"}</strong>
                <small>
                  {new Date(reminder.scheduledFor).toLocaleString("es-CO")}
                </small>
                <em className={`state ${reminder.state ?? ""}`}>
                  {labels[reminder.state ?? ""] ??
                    reminder.state ??
                    "Pendiente"}
                </em>
              </div>
              <button
                className="button-quiet"
                onClick={() => onAttempts(reminder.id)}
              >
                Ver intentos
              </button>
              {attempts[reminder.id] && (
                <div className="attempts">
                  {attempts[reminder.id].length === 0 ? (
                    <small>Sin intentos registrados.</small>
                  ) : (
                    attempts[reminder.id].map((attempt) => (
                      <div className="attempt" key={attempt.id}>
                        <span>Intento {attempt.attemptNumber}</span>
                        <b className={`state ${attempt.outcome ?? ""}`}>
                          {outcomeLabel(attempt.outcome)}
                        </b>
                        <small>
                          {new Date(attempt.preparedAt).toLocaleString("es-CO")}
                        </small>
                        {attempt.errorCode && (
                          <small className="error">{attempt.errorCode}</small>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DetailView({
  detail,
  current,
  busy,
  onMutate,
  request,
}: {
  detail: Detail;
  current?: Detail["versions"][number];
  busy: boolean;
  onMutate: (
    action: string,
    changes?: unknown,
    conflictId?: string,
    resolution?: string,
  ) => void;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(current?.title ?? "");
  const [amount, setAmount] = useState(current?.amount.amount ?? "");
  const [due, setDue] = useState(current?.due?.date ?? current?.due?.at ?? "");
  const original = {
    title: current?.title ?? "",
    amount: current?.amount.amount ?? "",
    due: current?.due?.date ?? current?.due?.at ?? "",
  };
  const editable = detail.state === "candidate" || detail.state === "confirmed";
  return (
    <div>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">DETALLE</p>
          <h2 id="detail-title">{current?.title}</h2>
          <span className={`state ${detail.state}`}>
            {labels[detail.state] ?? detail.state}
          </span>
        </div>
        <span className="revision">Revisión {current?.revision}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Importe</dt>
          <dd>{current && money(current.amount)}</dd>
        </div>
        <div>
          <dt>Vencimiento</dt>
          <dd>{dueText(current?.due ?? null)}</dd>
        </div>
        <div>
          <dt>Actualizado</dt>
          <dd>{new Date(detail.updatedAt).toLocaleString("es-CO")}</dd>
        </div>
      </dl>
      <div className="actions">
        {detail.state === "candidate" && (
          <button disabled={busy} onClick={() => onMutate("confirm")}>
            Confirmar
          </button>
        )}
        {detail.state === "confirmed" && (
          <button disabled={busy} onClick={() => onMutate("pay")}>
            Marcar pagada
          </button>
        )}
        {editable && (
          <button
            className="button-secondary"
            disabled={busy}
            onClick={() => setEditing(!editing)}
          >
            Corregir
          </button>
        )}
        {["candidate", "confirmed", "conflict"].includes(detail.state) && (
          <button
            className="button-danger"
            disabled={busy}
            onClick={() => onMutate("discard")}
          >
            Descartar
          </button>
        )}
      </div>
      {editing && (
        <form
          className="edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            const changes: Record<string, unknown> = {};
            if (title !== original.title) changes.title = title;
            if (amount !== original.amount)
              changes.amount = {
                amount,
                currency: current?.amount.currency ?? "COP",
              };
            if (due !== original.due && current?.due)
              changes.due =
                current.due.kind === "civil_date"
                  ? {
                      kind: "civil_date",
                      date: due,
                      timeZone: current.due.timeZone,
                    }
                  : {
                      kind: "instant",
                      at: due,
                      timeZone: current.due.timeZone,
                    };
            if (Object.keys(changes).length) onMutate("correct", changes);
            setEditing(false);
          }}
        >
          <label htmlFor="edit-title">
            Título
            <input
              id="edit-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label htmlFor="edit-amount">
            Importe
            <input
              id="edit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label htmlFor="edit-due">
            Vencimiento
            <input
              id="edit-due"
              type={current?.due?.kind === "civil_date" ? "date" : "text"}
              value={due}
              onChange={(event) => setDue(event.target.value)}
            />
          </label>
          <button disabled={busy} type="submit">
            Guardar corrección
          </button>
        </form>
      )}
      <section className="subsection">
        <h3>Historial</h3>
        {detail.versions.map((version) => (
          <article className="history-item" key={version.id}>
            <div>
              <strong>Revisión {version.revision}</strong>
              <span>{labels[version.state] ?? version.state}</span>
            </div>
            <p>
              {version.title} · {money(version.amount)} · {dueText(version.due)}
            </p>
            <EvidenceList evidence={version.evidence} request={request} />
          </article>
        ))}
      </section>
      {detail.protectedFields.length > 0 && (
        <section className="subsection">
          <h3>Campos protegidos</h3>
          <p className="muted">
            Confirmados o corregidos manualmente:{" "}
            {detail.protectedFields.map((field) => field.field).join(", ")}.
          </p>
        </section>
      )}
      {detail.conflicts.length > 0 && (
        <section className="subsection">
          <h3>Conflictos</h3>
          {detail.conflicts.map((conflict) => (
            <article className="conflict" key={conflict.id}>
              <strong>{conflict.reason}</strong>
              <p>{JSON.stringify(conflict.proposal)}</p>
              {conflict.state === "open" && (
                <div className="actions">
                  <button
                    onClick={() =>
                      onMutate("resolve", undefined, conflict.id, "accept")
                    }
                  >
                    Aceptar propuesta
                  </button>
                  <button
                    className="button-secondary"
                    onClick={() =>
                      onMutate("resolve", undefined, conflict.id, "reject")
                    }
                  >
                    Rechazar
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function EvidenceList({
  evidence,
  request,
}: {
  evidence: Evidence[];
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  return (
    <div className="evidence">
      <h4>Evidencia ({evidence.length})</h4>
      {evidence.map((item) => (
        <div className="evidence-item" key={item.id}>
          <div>
            <strong>
              {item.kind === "pdf_text_fragment" ? "PDF" : "Correo"}
            </strong>
            <p>“{item.quote}”</p>
            <small>
              Hash: {item.contentSha256.slice(0, 12)}…
              {item.page ? ` · Página ${item.page}` : ""}
            </small>
          </div>
          <button
            className="button-quiet"
            onClick={async () => {
              if (open === item.id) {
                setOpen(null);
                return;
              }
              try {
                const result = await request<{ text: string }>(
                  `${item.url}/text`,
                );
                setText(result.text);
                setOpen(item.id);
              } catch {
                setText("No se pudo cargar el texto de esta evidencia.");
                setOpen(item.id);
              }
            }}
          >
            {open === item.id ? "Ocultar texto" : "Ver texto"}
          </button>
          <button
            className="button-quiet"
            onClick={() => window.location.assign(`${item.url}/source`)}
          >
            Descargar fuente
          </button>
          {open === item.id && <pre>{text}</pre>}
        </div>
      ))}
    </div>
  );
}
