/**
 * BioPassport Registry Contract Entry Point
 */

export { BioPassportRegistry } from './registry';
export * from './types';

import { BioPassportRegistry } from './registry';

// Export contract instance for PureChain
export const contracts = [BioPassportRegistry];
