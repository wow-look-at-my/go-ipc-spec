// Checks that the spec files agree with each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const readJSON = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const wire = readJSON('wire.json');
const ring = wire.ring;
const field = (name: string) => {
	const f = ring.fields.find((x: { name: string }) => x.name === name);
	assert.ok(f, `wire.json has no ring field ${name}`);
	return f as { name: string; offset: number; size: number };
};

test('ring fields fit the control block and do not overlap', () => {
	const sorted = [...ring.fields].sort((a, b) => a.offset - b.offset);
	let end = 0;
	for (const f of sorted) {
		assert.ok(f.offset >= end, `${f.name} overlaps the field before it`);
		assert.equal(f.offset % f.size, 0, `${f.name} is not aligned to its size`);
		end = f.offset + f.size;
	}
	assert.ok(end <= ring.control_size, 'fields run past the control block');
	assert.equal(ring.control_size, 4 * ring.cache_line);
	const slots = ring.claim_slots;
	assert.equal(slots.offset, ring.control_size, 'the claim slot table follows the control block');
	assert.equal(slots.offset + slots.count * slots.slot_size, ring.header_size, 'the claim slot table ends the header');
	let slotEnd = 0;
	for (const f of slots.fields) {
		assert.ok(f.offset >= slotEnd && f.offset % f.size === 0, `slot field ${f.name} is misplaced`);
		slotEnd = f.offset + f.size;
	}
	assert.ok(slotEnd <= slots.slot_size, 'slot fields run past the slot');
	for (const n of ['tail', 'head', 'head_cache']) {
		assert.equal(field(n).offset % ring.cache_line, 0, `${n} must start a cache line`);
	}
});

test('service types sit below the padding type and do not collide', () => {
	const svc = wire.service;
	const types = [svc.type_knock, svc.type_hello, svc.type_error];
	assert.equal(new Set(types).size, types.length, 'service record types collide');
	for (const t of types) {
		assert.ok(t >= svc.reserved_type_min, `service type ${t} lies outside the reserved range`);
		assert.ok(t < ring.type_padding, `service type ${t} collides with padding`);
	}
	assert.ok(svc.reserved_type_min > wire.conn.type_eof, 'the reserved range overlaps the conn types');
	assert.equal(svc.sequence_size, 8);
	assert.equal(svc.first_sequence, 1);
	assert.equal(svc.client_id_hex_digits, wire.paths.instance_id_hex_digits);
});

const values = readJSON('vectors/schema/values.json');
const invalid = readJSON('vectors/schema/invalid.json');
const schemaSrc = readFileSync(join(root, 'vectors/schema/example.ipc'), 'utf8');
const declared = new Set([...schemaSrc.matchAll(/^message\s+(\w+)/gm)].map((m) => m[1]));

test('every schema value has an encoding and every encoding has a value', () => {
	const bins = readdirSync(join(root, 'vectors/schema')).filter((f) => f.endsWith('.bin')).sort();
	const want = values.map((_: unknown, i: number) => `${i}.bin`).sort();
	assert.deepEqual(bins, want);
});

test('schema vectors name only declared messages and known error kinds', () => {
	for (const [i, v] of values.entries()) {
		assert.ok(declared.has(v.message), `values.json entry ${i} names undeclared message ${v.message}`);
	}
	const kinds = new Set(['short', 'length', 'trailing', 'bool', 'utf8']);
	for (const [i, v] of invalid.entries()) {
		assert.ok(declared.has(v.message), `invalid.json entry ${i} names undeclared message ${v.message}`);
		assert.ok(kinds.has(v.error), `invalid.json entry ${i} has unknown kind ${v.error}`);
		assert.match(v.hex, /^([0-9a-f]{2})*$/, `invalid.json entry ${i} is not lower-case hex`);
	}
});

const manifest = readJSON('vectors/ring/manifest.json');
const ringDir = join(root, 'vectors/ring');

test('every ring case has an image and every image has a case', () => {
	const cases = new Set<string>(manifest.cases.map((c: { name: string }) => c.name));
	const images = new Set(readdirSync(ringDir).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4)));
	assert.deepEqual([...images].sort(), [...cases].sort());
});

for (const c of manifest.cases) {
	test(`ring image ${c.name} matches its manifest entry`, () => {
		const img = readFileSync(join(ringDir, `${c.name}.bin`));
		assert.equal(img.length, c.buffer_size);
		const u64 = (name: string) => img.readBigUInt64LE(field(name).offset);
		assert.equal(u64('magic'), BigInt(ring.magic));
		assert.equal(img.readUInt32LE(field('version').offset), ring.version);
		const capacity = u64('capacity');
		assert.equal(capacity & (capacity - 1n), 0n, 'capacity is not a power of two');
		assert.ok(capacity >= BigInt(ring.min_capacity));
		assert.ok(BigInt(ring.header_size) + capacity <= BigInt(c.buffer_size));
		assert.equal(u64('head'), BigInt(c.head));
		assert.equal(u64('tail'), BigInt(c.tail));
		assert.ok(u64('tail') - u64('head') <= capacity, 'more bytes in flight than capacity');

		const data = img.subarray(ring.header_size, ring.header_size + Number(capacity));
		const live = Number(u64('tail') - u64('head'));
		const start = Number(u64('head') & (capacity - 1n));
		for (let off = live; off < data.length; off++) {
			const i = (start + off) % data.length;
			assert.equal(data[i], 0, `byte ${i} of the data region is outside [head, tail) and must be zero`);
		}
	});
}
