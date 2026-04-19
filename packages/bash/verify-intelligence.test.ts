import { describe, it, expect } from 'vitest';
import { Bash, DebuggerBridge } from './src/index.js';

describe('Ag-Bash Intelligence Layer Verification', () => {
  it('should support breakpoints and stepping via DebuggerBridge', async () => {
    const debugBridge = new DebuggerBridge();
    const bash = new Bash({ 
      debugger: debugBridge,
      parserEngine: 'legacy' // Explicitly use legacy parser for breakpoint line tracking
    });

    // Use absolute lines starting with commands
    const script = `echo "Line 1"
echo "Line 2"
echo "Line 3 (Breakpoint)"
echo "Line 4"`;

    // DEBUG: Inject line printer into the bridge to see hit events
    const originalOnBefore = debugBridge.onBeforeStatement;
    debugBridge.onBeforeStatement = async function(node, state) {
      console.log('--- INTERPRETER HIT: Line ' + node.line + ' | Text: ' + (node.sourceText || '').trim());
      // @ts-ignore
      return originalOnBefore.call(this, node, state);
    };

    // Set a breakpoint on line 3 (1-indexed)
    debugBridge.setBreakpoint(3);
    console.log('--- TEST LOG: Breakpoint set on line 3');

    // Start execution
    let resolved = false;
    const execPromise = bash.exec(script).then(r => {
        resolved = true;
        return r;
    });

    // Poll for paused state
    let pausedAtLine3 = false;
    for (let i = 0; i < 50; i++) {
        // @ts-ignore
      if (debugBridge.paused) {
        pausedAtLine3 = true;
        console.log('--- TEST LOG: Execution PAUSED');
        break;
      }
      if (resolved) {
          console.log('--- TEST LOG: Execution finished PREMATURELY');
          break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    
    expect(pausedAtLine3).toBe(true);

    // Step once
    console.log('--- TEST LOG: Calling step()');
    debugBridge.step();

    // Poll for pause again after step
    let pausedAtLine4 = false;
    for (let i = 0; i < 50; i++) {
        // @ts-ignore
      if (debugBridge.paused) {
         pausedAtLine4 = true;
         console.log('--- TEST LOG: Execution PAUSED again after step');
         break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(pausedAtLine4).toBe(true);

    // Continue to end
    console.log('--- TEST LOG: Calling continue()');
    debugBridge.continue();

    const result = await execPromise;
    console.log('--- TEST LOG: Execution finished');
    expect(result.stdout).toContain('Line 1');
    expect(result.stdout).toContain('Line 4');
    expect(result.exitCode).toBe(0);
  }, 15000);
});
