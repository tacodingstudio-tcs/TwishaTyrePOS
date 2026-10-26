// TwishaPOS.exe — the one icon on Yogesh's desktop.
//
//   double-click   starts the database, the job store and the app (first time: also creates the database and the shop),
//                  shows what it is doing, then opens the app window. A tray icon stays near the clock.
//   tray menu      Open · Back up now · Status · Quit (stops everything, with a backup)
//   TwishaPOS.exe --stop | --backup | --status     one-off actions (used by the installer / the .bat helpers)
//
// All the real work is done by scripts\cli.mjs (see its header); this program only runs it and shows the result.
// Written for the C# 5 compiler that ships inside Windows (no SDK needed to rebuild it): deploy\offline\launcher\build.ps1
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    public static string Root;
    public static string Node;
    public static string Cli;

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    static extern uint SetErrorMode(uint mode);

    [STAThread]
    static int Main(string[] args)
    {
        // Programs started from here (inherited): no "Application Error 0xc0000142" box that waits for a click while the
        // start-up waits for the program. They just end with an error code, and cli.mjs starts them again.
        SetErrorMode(0x0001 | 0x0002 | 0x8000);   // SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
        Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Node = Path.Combine(Root, "node\\node.exe");
        Cli = Path.Combine(Root, "scripts\\cli.mjs");
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        if (!File.Exists(Node) || !File.Exists(Cli))
        {
            MessageBox.Show("Twisha POS files are missing next to this program:\n\n" + Root + "\n\nPlease run the installer again.",
                "Twisha POS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        // --spawn <log file> <working folder> <program> [arguments...]
        // Starts a long-running program (database, job store, app) with NO window, its output going to the log file, and returns
        // at once. cli.mjs asks for this instead of starting them itself: Node puts the programs it starts in a "die with me" group
        // (so they would die as soon as the start-up step ends) and, if told to detach, gives each its own console (which Windows
        // Terminal turns into a visible window). A program started from here is neither.
        if (args.Length >= 4 && args[0] == "--spawn")
        {
            StringBuilder cmd = new StringBuilder();
            cmd.Append("/d /v:on /c \"\"").Append(args[3]).Append("\"");
            for (int i = 4; i < args.Length; i++) cmd.Append(' ').Append(QuoteArg(args[i]));
            // when the program ends, say so in its log: cli.mjs uses it to tell "died at start-up" from "slow to start"
            cmd.Append(" >> \"").Append(args[1]).Append("\" 2>&1 & echo [twisha-exit !errorlevel!] >> \"").Append(args[1]).Append("\"\"");
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmd.ToString());
            psi.WorkingDirectory = args[2];
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
            return 0;
        }

        // one-off actions
        if (args.Length > 0 && (args[0] == "--stop" || args[0] == "--backup" || args[0] == "--status"))
        {
            string cmd = args[0].Substring(2);
            string output;
            int code = Cli_Run(cmd, out output, 120000);
            if (args[0] == "--stop")
            {
                // a running tray icon would otherwise be left pointing at services that are gone
                int me = Process.GetCurrentProcess().Id;
                foreach (Process other in Process.GetProcessesByName("TwishaPOS"))
                {
                    if (other.Id != me) { try { other.Kill(); } catch { } }
                }
            }
            if (args[0] == "--status") MessageBox.Show(output, "Twisha POS", MessageBoxButtons.OK, code == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            return code;
        }

        bool first;
        using (Mutex one = new Mutex(true, "Local\\TwishaPOS-Shakti-Enterprise", out first))
        {
            if (!first)
            {
                // Already running: "start" is safe to repeat — it only starts what is down (after a restore or a crash), then
                // opens the app window again.
                string text;
                int code = Cli_Run("start", out text, 180000);
                if (code != 0) MessageBox.Show("Twisha POS could not start everything:\n\n" + Tail(text, 8), "Twisha POS", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return code;
            }
            Application.Run(new MainContext());
        }
        return 0;
    }

    static string Tail(string text, int lines)
    {
        string[] all = text.Replace("\r", "").Split('\n');
        int from = Math.Max(0, all.Length - lines - 1);
        return string.Join("\n", all, from, all.Length - from).Trim();
    }

    static string QuoteArg(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
        return "\"" + a.Replace("\"", "\\\"") + "\"";
    }

    /// <summary>Runs "node scripts\cli.mjs &lt;args&gt;" hidden and waits; returns the exit code and all the text it printed.</summary>
    public static int Cli_Run(string arguments, out string output, int timeoutMs)
    {
        StringBuilder sb = new StringBuilder();
        Process p = StartCli(arguments, delegate(string line) { lock (sb) { sb.AppendLine(line); } });
        if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } sb.AppendLine("(timed out)"); output = sb.ToString(); return 1; }
        p.WaitForExit();   // flush the async output
        output = sb.ToString();
        return p.ExitCode;
    }

    public static Process StartCli(string arguments, Action<string> onLine)
    {
        ProcessStartInfo psi = new ProcessStartInfo(Node, "\"" + Cli + "\" " + arguments);
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.EnvironmentVariables["TWISHA_NO_DETACH"] = "1";   // services share our hidden console instead of opening windows of their own
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        Process p = new Process();
        p.StartInfo = psi;
        DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) onLine(e.Data); };
        p.OutputDataReceived += h;
        p.ErrorDataReceived += h;
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        return p;
    }
}

class MainContext : ApplicationContext
{
    NotifyIcon tray;
    StartForm form;
    bool ready;
    bool quitting;

    public MainContext()
    {
        Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        tray = new NotifyIcon();
        tray.Icon = icon;
        tray.Text = "Twisha POS (starting...)";
        tray.Visible = true;
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open Twisha POS", null, delegate { OpenApp(); });
        menu.Items.Add("Back up now", null, delegate { BackupNow(); });
        menu.Items.Add("Backup settings (where to save)...", null, delegate { try { Process.Start(Path.Combine(Program.Root, "Backup.exe")); } catch { } });
        menu.Items.Add("Show status", null, delegate { ShowStatus(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit (stop and back up)", null, delegate { Quit(); });
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += delegate { OpenApp(); };

        Microsoft.Win32.SystemEvents.SessionEnding += delegate { StopBlocking(); };

        form = new StartForm(icon);
        form.RetryClicked += delegate { StartAll(); };
        form.QuitClicked += delegate { QuitNow(); };
        form.Show();
        StartAll();
    }

    void StartAll()
    {
        form.Reset();
        Thread t = new Thread(delegate()
        {
            bool done = false;
            int code = 1;
            try
            {
                Process p = Program.StartCli("start", delegate(string line) { form.Append(line); });
                p.WaitForExit();
                p.WaitForExit();
                code = p.ExitCode;
                done = true;
            }
            catch (Exception ex) { form.Append("  X " + ex.Message); }
            form.BeginInvoke((MethodInvoker)delegate { Finished(done && code == 0); });
        });
        t.IsBackground = true;
        t.Start();
    }

    void Finished(bool ok)
    {
        if (ok)
        {
            ready = true;
            tray.Text = "Twisha POS - running";
            form.Hide();
            tray.ShowBalloonTip(4000, "Twisha POS", "Ready. Use the icon near the clock to open it again or to quit.", ToolTipIcon.Info);
        }
        else
        {
            tray.Text = "Twisha POS - needs attention";
            form.ShowFailure();
        }
    }

    void OpenApp()
    {
        if (!ready) { form.Show(); form.Activate(); return; }
        ThreadPool.QueueUserWorkItem(delegate { string o; Program.Cli_Run("open", out o, 15000); });
    }

    void BackupNow()
    {
        tray.ShowBalloonTip(3000, "Twisha POS", "Backing up...", ToolTipIcon.Info);
        ThreadPool.QueueUserWorkItem(delegate
        {
            string o; int c = Program.Cli_Run("backup", out o, 180000);
            string last = LastUseful(o);
            tray.ShowBalloonTip(5000, "Twisha POS", c == 0 ? "Backup saved. " + last : "Backup failed. " + last, c == 0 ? ToolTipIcon.Info : ToolTipIcon.Error);
        });
    }

    void ShowStatus()
    {
        string o; int c = Program.Cli_Run("status", out o, 30000);
        MessageBox.Show(o, "Twisha POS - status", MessageBoxButtons.OK, c == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    void Quit()
    {
        if (MessageBox.Show("Stop Twisha POS now?\n\nA backup is taken first. Make sure no bill is being saved.",
            "Quit", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        QuitNow();
    }

    void QuitNow()
    {
        if (quitting) return;
        quitting = true;
        tray.Text = "Twisha POS - stopping...";
        form.ShowStopping();
        Thread t = new Thread(delegate()
        {
            StopBlocking();
            form.BeginInvoke((MethodInvoker)delegate { tray.Visible = false; tray.Dispose(); ExitThread(); });
        });
        t.IsBackground = true;
        t.Start();
    }

    void StopBlocking()
    {
        string o; Program.Cli_Run("stop", out o, 120000);
    }

    static string LastUseful(string text)
    {
        string[] lines = text.Replace("\r", "").Split('\n');
        for (int i = lines.Length - 1; i >= 0; i--) { string l = lines[i].Trim(); if (l.Length > 0) return l.Length > 120 ? l.Substring(0, 120) : l; }
        return "";
    }
}

class StartForm : Form
{
    Label title, status;
    ProgressBar bar;
    TextBox details;
    Button retry, quit, copy;
    List<string> all = new List<string>();
    public event EventHandler RetryClicked;
    public event EventHandler QuitClicked;

    public StartForm(Icon icon)
    {
        Text = "Twisha POS";
        Icon = icon;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = true;
        ClientSize = new Size(520, 330);
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;      // positions grow with the screen's text size, so nothing is clipped
        Font = new Font("Segoe UI", 9.5f);

        PictureBox logo = new PictureBox();
        logo.Image = icon.ToBitmap();
        logo.SizeMode = PictureBoxSizeMode.Zoom;
        logo.SetBounds(20, 18, 56, 56);
        Controls.Add(logo);

        title = new Label();
        title.Text = "Twisha POS";
        title.Font = new Font("Segoe UI Semibold", 15f);
        title.SetBounds(88, 14, 410, 36);
        Controls.Add(title);

        status = new Label();
        status.Text = "Starting...";
        status.SetBounds(90, 54, 410, 26);
        Controls.Add(status);

        bar = new ProgressBar();
        bar.Style = ProgressBarStyle.Marquee;
        bar.MarqueeAnimationSpeed = 25;
        bar.SetBounds(20, 92, 480, 14);
        Controls.Add(bar);

        details = new TextBox();
        details.Multiline = true; details.ReadOnly = true; details.ScrollBars = ScrollBars.Vertical;
        details.Font = new Font("Consolas", 8.5f);
        details.SetBounds(20, 120, 480, 150);
        Controls.Add(details);

        retry = new Button(); retry.Text = "Try again"; retry.SetBounds(20, 284, 110, 32); retry.Visible = false;
        retry.Click += delegate { if (RetryClicked != null) RetryClicked(this, EventArgs.Empty); };
        Controls.Add(retry);
        copy = new Button(); copy.Text = "Copy details"; copy.SetBounds(140, 284, 110, 32); copy.Visible = false;
        copy.Click += delegate { try { Clipboard.SetText(string.Join("\r\n", all.ToArray())); } catch { } };
        Controls.Add(copy);
        quit = new Button(); quit.Text = "Close"; quit.SetBounds(390, 284, 110, 32); quit.Visible = false;
        quit.Click += delegate { if (QuitClicked != null) QuitClicked(this, EventArgs.Empty); };
        Controls.Add(quit);

        FormClosing += delegate(object s, FormClosingEventArgs e)
        {
            // the X only tucks the window away; Quit is in the tray menu
            if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; if (quit.Visible) { if (QuitClicked != null) QuitClicked(this, EventArgs.Empty); } else Hide(); }
        };
    }

    public void Reset()
    {
        all.Clear(); details.Text = "";
        status.Text = "Starting...";
        bar.Style = ProgressBarStyle.Marquee; bar.Visible = true;
        retry.Visible = false; copy.Visible = false; quit.Visible = false;
        title.Text = "Twisha POS";
    }

    public void Append(string line)
    {
        if (IsDisposed) return;
        BeginInvoke((MethodInvoker)delegate
        {
            all.Add(line);
            if (line.StartsWith("STEP ")) status.Text = line.Substring(5);
            details.AppendText(line + "\r\n");
        });
    }

    public void ShowFailure()
    {
        bar.Visible = false;
        title.Text = "Could not start";
        status.Text = "Read the last lines below. Click Try again after fixing it.";
        retry.Visible = true; copy.Visible = true; quit.Visible = true;
        Show(); Activate();
    }

    public void ShowStopping()
    {
        Show(); Activate();
        title.Text = "Stopping...";
        status.Text = "Backing up and shutting down. Please wait.";
        bar.Style = ProgressBarStyle.Marquee; bar.Visible = true;
        retry.Visible = false; copy.Visible = false; quit.Visible = false;
    }
}
