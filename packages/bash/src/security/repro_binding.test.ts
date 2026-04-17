
import { describe, it, expect } from 'vitest';
import { DefenseInDepthBox } from './defense-in-depth-box.js';

interface ProcessWithBinding extends NodeJS.Process {
  binding: (name: string) => unknown;
}

describe('Restoration Repro', () => {
  it('should restore process.binding', () => {
    const proc = process as unknown as ProcessWithBinding;
    const isProxy = (fn: unknown): boolean => 
      typeof fn === 'function' && fn.toString().includes('native code') === false;
    
    console.log('--- Initial State ---');
    const initialIsProxy = isProxy(proc.binding);
    console.log('is process.binding likely a proxy?', initialIsProxy);

    const box = DefenseInDepthBox.getInstance({ enabled: true });
    const originalBinding = proc.binding;
    
    console.log('--- Activated State ---');
    const handle = box.activate();
    const activatedBinding = proc.binding;
    console.log('Is same reference?', activatedBinding === originalBinding);
    expect(activatedBinding).not.toBe(originalBinding);

    handle.deactivate();
    console.log('\n--- Deactivated State ---');
    expect(proc.binding).toBe(originalBinding);

    DefenseInDepthBox.resetInstance();
    console.log('\n--- Reset State ---');
    expect(proc.binding).toBe(originalBinding);
  });
});
