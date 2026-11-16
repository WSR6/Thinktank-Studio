import { execFile } from 'node:child_process';

/**
 * Seconds since the last mouse or keyboard input on this computer, or undefined when it can't be told
 * (no desktop session, an unsupported system, or the check failed). Used so the App helper only starts
 * tests that move the real mouse when nobody is using the computer.
 */
export function idleSeconds(): Promise<number | undefined> {
  const run = (cmd: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
    );
  const num = (s: string) => {
    const n = Number(s.trim());
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  if (process.platform === 'win32') {
    // GetLastInputInfo: milliseconds since boot of the last input, compared with the tick count now.
    const ps = [
      'Add-Type @"',
      'using System; using System.Runtime.InteropServices;',
      'public static class TtsIdle {',
      '  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }',
      '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);',
      '  public static double Seconds() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); if (!GetLastInputInfo(ref l)) return -1;',
      '    return ((uint)Environment.TickCount - l.dwTime) / 1000.0; }',
      '}',
      '"@',
      '[TtsIdle]::Seconds()',
    ].join('\n');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]).then(num, () => undefined);
  }
  if (process.platform === 'darwin') {
    // HIDIdleTime is in nanoseconds.
    return run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']).then(
      (out) => {
        const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
        return m ? Number(m[1]) / 1e9 : undefined;
      },
      () => undefined,
    );
  }
  // Linux desktops: xprintidle (X11) if installed, in milliseconds.
  return run('xprintidle', []).then(
    (out) => {
      const ms = num(out);
      return ms === undefined ? undefined : ms / 1000;
    },
    () => undefined,
  );
}
