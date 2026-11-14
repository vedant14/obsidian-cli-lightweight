export class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function requireThat(condition, code, message) {
  if (!condition) throw new CliError(code, message);
}
