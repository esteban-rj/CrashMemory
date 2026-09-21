export default function HomePage() {
  const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4310";

  return (
    <main>
      <h1>CrashMemory</h1>
      <p>
        Base local: Gmail → obligaciones con evidencia → avisos por Telegram.
      </p>
      <p>
        Esta pantalla es un esqueleto. La demo sintética está en la API local.
      </p>
      <a href={`${apiBaseUrl}/api/v1/demo/obligations`}>
        Ver obligación sintética
      </a>
    </main>
  );
}
