import type { ChildProcess } from 'node:child_process';
/** Capture cannot release its screen/audio lease until its owned producer exits. */
export function stopAndWait(process: ChildProcess | null): Promise<void> {
    if (!process || process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const done = (error?: Error) => {
            if (killTimer) clearTimeout(killTimer);
            if (timeout) clearTimeout(timeout);
            process.off('close', close); process.off('error', failed);
            if (error) reject(error); else resolve();
        };
        const close = () => done();
        const failed = (error: Error) => { if (!process.pid) done(); else done(error); };
        process.once('close', close); process.once('error', failed);
        process.kill('SIGTERM');
        killTimer = setTimeout(() => process.kill('SIGKILL'), 2000);
        timeout = setTimeout(() => done(new Error('Capture process did not exit; startup remains blocked')), 5000);
    });
}
