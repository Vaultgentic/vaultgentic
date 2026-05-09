export class VaultgenticError extends Error {
  readonly expected: boolean;

  constructor(
    message: string,
    options?: { cause?: unknown; expected?: boolean },
  ) {
    super(message, options);
    this.name = "VaultgenticError";
    this.expected = options?.expected ?? true;
  }
}
