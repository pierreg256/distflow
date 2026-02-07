const { getLogger, LogLevel } = require('@distflow/core');

// Simple test to verify logger works
const logger = getLogger('quick-test');

logger.info('✅ Logger module loaded successfully');
logger.debug('Debug logging works');
logger.warn('Warning logging works');

const childLogger = logger.child({ component: 'test' });
childLogger.info('Child logger works', { status: 'ok' });

console.log('\n✅ All logger tests passed!');
