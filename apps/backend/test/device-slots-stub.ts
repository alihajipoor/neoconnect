/** A DeviceSlotsService that records what it was asked and does nothing
 * -- for specs of the services that release slots (sign-out, eviction,
 * suspension, deletion) but are not about slots themselves. Specs about
 * slots use the real service over DeviceStateStore.inMemory(). */
export function deviceSlotsStub() {
  return {
    claim: jest.fn(),
    renew: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    releaseSession: jest.fn().mockResolvedValue(undefined),
    releaseOtherSessions: jest.fn().mockResolvedValue(undefined),
    releaseSubscription: jest.fn().mockResolvedValue(undefined),
    releaseCustomer: jest.fn().mockResolvedValue(undefined),
    keepAlive: jest.fn().mockResolvedValue(undefined),
    onGrant: jest.fn(),
    state: jest.fn().mockResolvedValue({ holders: new Set(), live: new Set(), displaced: new Map(), credit: new Map() }),
  };
}
