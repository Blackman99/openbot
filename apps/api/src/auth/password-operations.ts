export class AuthenticationBusyError extends Error {
  constructor() {
    super('Authentication is temporarily busy');
    this.name = 'AuthenticationBusyError';
  }
}

// Hashing and verification consume the same process memory, including across
// sign-in, owner setup, and invitation services.
class PasswordOperations {
  private active = 0;

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.active >= 2) throw new AuthenticationBusyError();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}

export const passwordOperations = new PasswordOperations();
