"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

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
        ? new Intl.DateTimeFormat("es-CO", {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(due.at))
        : "Fecha no disponible";
const money = (value: Obligation["amount"]) =>
  `${value.currency} ${value.amount}`;

export default function HomePage() {
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
  const [reviews, setReviews] = useState<
    Array<{ id: string; state: string; reasonCode?: string }>
  >([]);
  const [view, setView] = useState<"obligations" | "connections">(
    "obligations",
  );
  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(path, {
        ...init,
        credentials: "include",
        headers: {
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
      });
      if (response.status === 401) {
        setUser(null);
        setCsrf("");
        setSelected(null);
        throw new Error("Tu sesión terminó. Inicia sesión de nuevo.");
      }
      const payload = (await response
        .json()
        .catch(() => ({}))) as Envelope<T> & { error?: { message?: string } };
      if (!response.ok) {
        const error = new Error(
          payload.error?.message ?? "No se pudo completar la solicitud.",
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return payload.data;
    },
    [],
  );
  const load = useCallback(async () => {
    const [list, gmailState, telegramState, reviewState] = await Promise.all([
      request<Obligation[]>("/api/v1/obligations?limit=100"),
      request<Gmail[]>("/api/v1/gmail"),
      request<{ linked?: boolean; state?: string; linkedAt?: string | null }>(
        "/api/v1/telegram/status",
      ),
      request<Array<{ id: string; state: string; reasonCode?: string }>>(
        "/api/v1/extraction/reviews?limit=25",
      ),
    ]);
    setObligations(list);
    setGmail(gmailState);
    setTelegram(telegramState);
    setReviews(reviewState);
  }, [request]);
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
        sessionStorage.removeItem("crashmemory.session");
        setMessage(error.message);
      });
  }, [user, load]);
  async function login(event: FormEvent) {
    event.preventDefault();
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
      setLoginError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setSelected(await request<Detail>(`/api/v1/obligations/${id}`));
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
    } finally {
      setUser(null);
      setCsrf("");
      setSelected(null);
      setObligations([]);
      setGmail([]);
      setTelegram(null);
      setReviews([]);
      sessionStorage.removeItem("crashmemory.session");
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
                      onClick={() =>
                        void open(item.obligationId).catch((error: Error) =>
                          setMessage(error.message),
                        )
                      }
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
                <p>{reviews.length} extracción(es) necesita(n) atención.</p>
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
}: {
  gmail: Gmail[];
  telegram: {
    linked?: boolean;
    state?: string;
    linkedAt?: string | null;
  } | null;
  onGmail: () => void;
  onTelegram: () => void;
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
      </div>
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
                  : { kind: "instant", at: due };
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
            <small>Hash: {item.contentSha256.slice(0, 12)}…</small>
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
          {open === item.id && <pre>{text}</pre>}
        </div>
      ))}
    </div>
  );
}
