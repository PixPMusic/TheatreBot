import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';

interface Identity { pid: number; started: string; parent: number; group: number; state: string }
async function identity(pid: number): Promise<Identity | null> {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), started: fields[19] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
}
async function alive(owned: Identity): Promise<boolean> {
    const current = await identity(owned.pid);
    return !!current && current.started === owned.started && current.state !== 'Z';
}
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

/** Own only our spawned ChromeDriver and its verified descendants, never kill by name. */
export class BrowserProcess {
    private readonly owned = new Map<number, Identity>();
    private constructor(private readonly child: ChildProcess, public readonly url: string) {}
    static async launch(owned: (process: BrowserProcess) => void = () => {}): Promise<BrowserProcess> {
        if (process.platform !== 'linux') throw new Error('Persistent browser isolation requires Linux /proc process verification');
        const port = await new Promise<number>((resolve, reject) => {
            const socket = createServer();
            socket.once('error', reject);
            socket.listen(0, '127.0.0.1', () => {
                const address = socket.address();
                socket.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
            });
        });
        const child = spawn(process.env.CHROMEDRIVER_PATH || '/usr/lib64/chromium-browser/chromedriver', [`--port=${port}`, '--allowed-ips=127.0.0.1'], { stdio: 'ignore', detached: true });
        const processOwner = new BrowserProcess(child, `http://127.0.0.1:${port}`);
        owned(processOwner);
        let launchError: Error | undefined;
        child.on('error', error => { launchError = error; });
        for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
            if (launchError) throw launchError;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('ChromeDriver exited during startup');
            await processOwner.snapshot();
            try { if ((await fetch(`${processOwner.url}/status`, { signal: AbortSignal.timeout(250) })).ok) return processOwner; } catch {}
            await pause();
    }
        throw new Error('ChromeDriver did not become ready');
    }
    async snapshot(): Promise<void> {
        if (!this.child.pid) return;
        if (!this.owned.size) {
            if (this.child.exitCode !== null || this.child.signalCode !== null) return;
            const root = await identity(this.child.pid);
            if (!root || root.parent !== process.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
            this.owned.set(root.pid, root);
        }
        const entries = await readdir('/proc');
        const all = (await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(name => identity(Number(name))))).filter((entry): entry is Identity => !!entry);
        const ownedGroupAlive = all.some(entry => entry.group === this.child.pid && this.owned.get(entry.pid)?.started === entry.started);
        let changed = true;
        while (changed) {
            changed = false;
            for (const entry of all) if (this.owned.get(entry.pid)?.started !== entry.started && (ownedGroupAlive && entry.group === this.child.pid || all.some(parent => parent.pid === entry.parent && this.owned.get(parent.pid)?.started === parent.started))) {
                this.owned.set(entry.pid, entry); changed = true;
            }
        }
    }
    // ChromeDriver exposes goog:processID for locally launched desktop Chrome; verify it independently.
    async verifyChrome(pid: unknown, directory: string): Promise<void> {
        await this.snapshot();
        if (typeof pid !== 'number' || !this.owned.has(pid) || !(await alive(this.owned.get(pid)!))) throw new Error('Chrome process ownership could not be established');
        const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
        if (!args.includes(`--user-data-dir=${directory}`)) throw new Error('Chrome did not use the claimed profile');
    }
    async close(): Promise<void> {
        await this.snapshot();
        // Kill each recorded identity only while its start time still matches.
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
            for (const owned of this.owned.values()) if (await alive(owned)) {
                try { process.kill(owned.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            }
            for (const deadline = Date.now() + 2_000; Date.now() < deadline;) {
                await this.snapshot();
                if (!(await Promise.all([...this.owned.values()].map(alive))).some(Boolean)) {
                    // ChildProcess owns the launched service even if its exit notification lags /proc.
                    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
                }
                await pause();
            }
        }
        throw new Error('Owned browser processes are still running; profile remains locked');
    }
}
