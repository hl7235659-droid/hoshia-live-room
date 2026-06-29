export class DatabaseError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
