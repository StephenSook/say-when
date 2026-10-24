// Imported first by every test file. Any reach for the real network throws, so no test can call Cartesia.
const blocked = (): never => {
    throw new Error('The network is blocked in tests. Inject a fake fetch or socket.');
};

Object.defineProperty(globalThis, 'fetch', { value: blocked, writable: true, configurable: true });
Object.defineProperty(globalThis, 'WebSocket', {
    value: class {
        constructor() {
            blocked();
        }
    },
    writable: true,
    configurable: true,
});
