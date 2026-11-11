export class ManagedToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedToolError';
  }
}

export class WritePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WritePreconditionError';
  }
}
