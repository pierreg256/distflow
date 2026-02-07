import { getLogger, configureLogger, LogLevel, createTransport } from '@distflow/core';

/**
 * Example 1: Basic usage with global logger
 */
function basicUsage() {
  const logger = getLogger('my-service');

  logger.debug('This is a debug message', { userId: 123 });
  logger.info('Service started', { port: 3000 });
  logger.warn('High memory usage', { usage: '85%' });
  logger.error('Connection failed', new Error('ECONNREFUSED'));
}

/**
 * Example 2: Configure global logger
 */
function configuredLogger() {
  configureLogger({
    level: LogLevel.DEBUG,
    prettyPrint: true,
    name: 'my-app'
  });

  const logger = getLogger();
  logger.info('App configured');
}

/**
 * Example 3: Child logger with context
 */
function childLogger() {
  const logger = getLogger('api');

  // Create child with request context
  const requestLogger = logger.child({
    requestId: 'req-123',
    userId: 'user-456',
    ip: '192.168.1.1'
  });

  requestLogger.info('Request received');
  requestLogger.info('Processing payment');
  requestLogger.info('Request completed');

  // All logs will include the context
}

/**
 * Example 4: Custom transport
 */
function customTransport() {
  // Write to file or send to external service
  const fileTransport = createTransport((entry) => {
    // Example: write to file
    // fs.appendFileSync('app.log', JSON.stringify(entry) + '\n');

    // Example: send to logging service
    // fetch('http://logs.example.com', {
    //   method: 'POST',
    //   body: JSON.stringify(entry)
    // });

    console.log('Custom transport:', entry);
  });

  configureLogger({
    transport: fileTransport
  });

  const logger = getLogger();
  logger.info('Using custom transport');
}

/**
 * Example 5: Environment-based configuration
 */
function environmentConfig() {
  // Set LOG_LEVEL=DEBUG in environment
  // or NODE_ENV=production for non-pretty logs

  const logger = getLogger('env-example');
  logger.debug('This respects LOG_LEVEL env var');
}

/**
 * Example 6: With errors
 */
function errorLogging() {
  const logger = getLogger('error-handler');

  try {
    throw new Error('Something went wrong');
  } catch (err) {
    logger.error('Operation failed', err as Error);
    // Logs with error message, stack trace, and name
  }
}

/**
 * Example 7: Structured logging
 */
function structuredLogging() {
  const logger = getLogger('metrics');

  logger.info('Request processed', {
    duration: 123,
    status: 200,
    method: 'GET',
    path: '/api/users',
    responseSize: 1024
  });

  logger.info('Database query', {
    query: 'SELECT * FROM users',
    duration: 45,
    rows: 150
  });
}

// Run examples
console.log('\n=== Example 1: Basic Usage ===');
basicUsage();

console.log('\n=== Example 2: Configured Logger ===');
configuredLogger();

console.log('\n=== Example 3: Child Logger ===');
childLogger();

console.log('\n=== Example 4: Custom Transport ===');
customTransport();

console.log('\n=== Example 5: Environment Config ===');
environmentConfig();

console.log('\n=== Example 6: Error Logging ===');
errorLogging();

console.log('\n=== Example 7: Structured Logging ===');
structuredLogging();
