const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Accepts an unambiguous UTC second and rejects Date's normalized inputs. */
export function parseUtcInstant(value: string, name: string): Date {
  if (!UTC_SECOND.test(value)) {
    throw new Error(
      `${name} must be a UTC ISO-8601 instant (YYYY-MM-DDTHH:mm:ssZ)`,
    );
  }

  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== `${value.slice(0, -1)}.000Z`
  ) {
    throw new Error(`${name} must be a real UTC calendar instant`);
  }
  return parsed;
}
