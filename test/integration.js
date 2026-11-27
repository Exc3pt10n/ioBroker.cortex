const path = require('node:path');
const { expect } = require('chai');
const { gunzipSync } = require('node:zlib');
const { tests } = require('@iobroker/testing');

const LIGHT = '0_userdata.0.cortexTest.light';
const TEMPERATURE = '0_userdata.0.cortexTest.outdoorTemperature';

function sendTo(harness, command, message) {
    return new Promise(resolve => harness.sendTo('cortex.0', command, message, resolve));
}

function readFile(harness, id, name) {
    return new Promise((resolve, reject) =>
        harness.objects.readFile(id, name, (err, data) => (err ? reject(err) : resolve(data))),
    );
}

async function waitForState(harness, id, predicate, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const state = await harness.states.getStateAsync(id);
        if (state && predicate(state.val)) {
            return state.val;
        }
        if (Date.now() > until) {
            throw new Error(`${id} not reached, last value: ${state && state.val}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

// Starts the adapter in a real js-controller test instance
tests.integration(path.join(__dirname, '..'), {
    controllerVersion: 'latest',
    defineAdditionalTests({ suite }) {
        suite('Recorder with real objects', getHarness => {
            it('observes a light, classifies a command and exports it anonymously', async function () {
                this.timeout(120000);
                const harness = getHarness();
                await harness.objects.setObjectAsync(LIGHT, {
                    type: 'state',
                    common: { name: 'Test light', role: 'switch.light', type: 'boolean', read: true, write: true },
                    native: {},
                });
                await harness.objects.setObjectAsync('enum.rooms.cortex_test', {
                    type: 'enum',
                    common: { name: 'Test room', members: [LIGHT] },
                    native: {},
                });
                await harness.objects.setObjectAsync(TEMPERATURE, {
                    type: 'state',
                    common: { name: 'Outdoor', role: 'value.temperature', type: 'number', read: true, write: false },
                    native: {},
                });
                await harness.states.setStateAsync(TEMPERATURE, { val: 27.5, ack: true });
                await harness.changeAdapterConfig('cortex', { native: { contextTemperature: TEMPERATURE } });
                await harness.startAdapterAndWait();

                await waitForState(harness, 'cortex.0.info.status', v => v === 'recording');
                expect(await waitForState(harness, 'cortex.0.info.observedActions', v => v >= 1)).to.equal(1);
                const observed = JSON.parse((await harness.states.getStateAsync('cortex.0.info.observedStates')).val);
                expect(observed[0]).to.include({ id: LIGHT, room: 'Test room', kind: 'action', category: 'light' });

                // Command from a user interface, then the confirmation of the "device"
                await harness.states.setStateAsync(LIGHT, { val: true, ack: false, from: 'system.adapter.web.0' });
                await new Promise(r => setTimeout(r, 300));
                await harness.states.setStateAsync(LIGHT, { val: true, ack: true, from: 'system.adapter.web.0' });
                await new Promise(r => setTimeout(r, 1000));

                const response = await sendTo(harness, 'export', {});
                expect(response.error).to.equal(undefined);
                const name = response.result.split('cortex.0/')[1];
                const { file } = await readFile(harness, 'cortex.0', name).then(data =>
                    Buffer.isBuffer(data) ? { file: data } : data,
                );
                const lines = gunzipSync(file).toString('utf8').trim().split('\n').map(l => JSON.parse(l));
                const [header, ...events] = lines;
                expect(header.states.filter(s => s.role === 'switch.light')).to.have.length(1);
                expect(JSON.stringify(lines)).not.to.contain('cortexTest');
                // The test instance keeps its data directory between local runs: check the latest event
                const recorded = events.filter(e => e.type !== 'context');
                expect(recorded.length).to.be.greaterThan(0);
                expect(recorded.at(-1)).to.include({ o: 'ui', s: 'web', v: true });
                // Context value sampled at the start
                expect(events.filter(e => e.type === 'context').at(-1)).to.include({ k: 'temperature', v: 27.5 });
            });
        });
    },
});
