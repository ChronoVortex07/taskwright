import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  cancellationMarkerPath,
  writeCancellationMarker,
  isCancelled,
  clearCancellationMarker,
} from '../../core/cancellationMarker';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-marker-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('cancellationMarker', () => {
  it('path is <root>/.taskwright/cancelled', () => {
    expect(cancellationMarkerPath(root)).toBe(path.join(root, '.taskwright', 'cancelled'));
  });

  it('write creates the state dir + file; isCancelled flips false -> true', () => {
    expect(isCancelled(root)).toBe(false); // negative control (nothing written yet)
    const marker = writeCancellationMarker(root, 'TASK-7', new Date('2026-07-03T12:00:00Z'));
    expect(marker).toEqual({ taskId: 'TASK-7', cancelledAt: '2026-07-03T12:00:00.000Z' });
    expect(fs.existsSync(cancellationMarkerPath(root))).toBe(true);
    expect(isCancelled(root)).toBe(true);
    // File content is JSON with the task id (human/debug legibility only).
    const raw = JSON.parse(fs.readFileSync(cancellationMarkerPath(root), 'utf-8'));
    expect(raw.taskId).toBe('TASK-7');
  });

  it('detection is PRESENCE-ONLY — a non-JSON marker still reads as cancelled', () => {
    // Contract divergence from activeTask.ts: isCancelled never PARSES the file.
    fs.mkdirSync(path.join(root, '.taskwright'), { recursive: true });
    fs.writeFileSync(cancellationMarkerPath(root), 'not json at all', 'utf-8');
    expect(isCancelled(root)).toBe(true);
  });

  it('clear removes the marker; isCancelled returns to false; idempotent', () => {
    writeCancellationMarker(root, 'TASK-7');
    clearCancellationMarker(root);
    expect(isCancelled(root)).toBe(false);
    // Idempotent — clearing an already-absent marker does not throw.
    expect(() => clearCancellationMarker(root)).not.toThrow();
  });

  it('isCancelled never throws on a non-existent root', () => {
    const missing = path.join(root, 'does', 'not', 'exist');
    expect(() => isCancelled(missing)).not.toThrow();
    expect(isCancelled(missing)).toBe(false);
  });
});
