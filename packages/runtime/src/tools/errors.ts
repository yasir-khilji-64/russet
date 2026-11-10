export class ManagedToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedToolError';
  }
}
