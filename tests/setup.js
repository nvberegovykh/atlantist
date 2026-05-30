/**
 * tests/setup.js
 *
 * Jest global setup/teardown. Runs before every test file.
 * Sets up test environment, mocks, and shared utilities.
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Increase Jest timeout for async operations
jest.setTimeout(15000);

// Global afterAll hook to close any open connections
afterAll(async () => {
  // Allow pending operations to complete before exit
  await new Promise(resolve => setTimeout(resolve, 100));
});