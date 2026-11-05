// TwishaKill.exe <folder> — ends every program that runs from <folder> (the database, the job store, the app server, the tray icon),
// except itself. Used by the installer before it replaces files; nothing outside the folder is touched.
//
// A windowless (winexe) program on purpose: the installer used to do this with a hidden PowerShell, and on laptops where Windows
// Terminal is the default console host every such start flashed a terminal window.
// Exit code: 0 = nothing of ours is left running, 1 = something could not be ended.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class TwishaKill
{
    static int Main(string[] args)
    {
        if (args.Length < 1) return 2;
        string root = Path.GetFullPath(args[0]).TrimEnd('\\') + "\\";
        int me = Process.GetCurrentProcess().Id;
        int left = 0;
        for (int round = 0; round < 3; round++)
        {
            left = 0;
            foreach (Process p in Process.GetProcesses())
            {
                if (p.Id == me) continue;
                string file = null;
                try { file = p.MainModule.FileName; } catch { continue; }          // protected / already gone
                if (file == null || !file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                try { p.Kill(); p.WaitForExit(5000); } catch { left++; }
            }
            if (left == 0) break;
            Thread.Sleep(500);
        }
        Thread.Sleep(800);   // let Windows release the file handles
        return left == 0 ? 0 : 1;
    }
}
