// Backup.exe — take a backup of Twisha POS, and choose where backups go.
//
//   double-click      a small window: where backups are kept, an optional second place (pen drive / external disk), Back up now
//   Backup.exe --now [--out <file>]     back up straight away, no window (the result is written to <file> if given)
//   Backup.exe --set-folder <folder> | --set-copy <folder|none>     change the settings without the window (used by the tests)
//
// The settings live in %LOCALAPPDATA%\TwishaPOS\backup-settings.json and are read by scripts\cli.mjs, so EVERY backup — this
// button, the tray menu, and the automatic one when Twisha POS is closed — goes to the places chosen here.
// Works with the app closed (cli.mjs starts the database just for the length of the backup).
// Written for the C# 5 compiler that ships inside Windows: deploy\offline\launcher\build.ps1
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class BackupProgram
{
    public static string Root, Node, Cli, SettingsFile, DefaultFolder;

    [STAThread]
    static int Main(string[] args)
    {
        Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Node = Path.Combine(Root, "node\\node.exe");
        Cli = Path.Combine(Root, "scripts\\cli.mjs");
        string data = Environment.GetEnvironmentVariable("TWISHA_DATA");
        if (string.IsNullOrEmpty(data)) data = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"), "TwishaPOS");
        SettingsFile = Path.Combine(data, "backup-settings.json");
        DefaultFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TwishaPOS Backups");
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TWISHA_DEFAULT_BACKUPS"))) DefaultFolder = Environment.GetEnvironmentVariable("TWISHA_DEFAULT_BACKUPS");   // (for tests)

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (!File.Exists(Node) || !File.Exists(Cli))
        {
            MessageBox.Show("Twisha POS files are missing next to this program:\n\n" + Root + "\n\nPlease run the installer again.", "Backup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        string outFile = null;
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--out") outFile = args[i + 1];

        if (args.Length >= 2 && args[0] == "--set-folder") { Save(args[1], Load("copyTo")); return 0; }
        if (args.Length >= 2 && args[0] == "--set-copy") { Save(Load("folder"), args[1] == "none" ? "" : args[1]); return 0; }
        if (args.Length >= 1 && args[0] == "--now")
        {
            string text; int code = RunBackup(out text);
            if (outFile != null) File.WriteAllText(outFile, text, Encoding.UTF8);
            else MessageBox.Show(Summary(text, code), "Backup", MessageBoxButtons.OK, code == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            return code;
        }
        Application.Run(new BackupForm());
        return 0;
    }

    // ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────
    public static string Load(string key)
    {
        try
        {
            if (!File.Exists(SettingsFile)) return "";
            Dictionary<string, object> d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsFile));
            object v; return d.TryGetValue(key, out v) && v != null ? v.ToString() : "";
        }
        catch { return ""; }
    }

    public static void Save(string folder, string copyTo)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsFile));
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["folder"] = folder ?? "";
        d["copyTo"] = copyTo ?? "";
        File.WriteAllText(SettingsFile, new JavaScriptSerializer().Serialize(d), new UTF8Encoding(false));   // no byte-order mark: the runtime reads this file as JSON
    }

    // ── the backup itself: scripts\cli.mjs does the work ───────────────────────────────────────────────────────────
    public static int RunBackup(out string output)
    {
        StringBuilder sb = new StringBuilder();
        ProcessStartInfo psi = new ProcessStartInfo(Node, "\"" + Cli + "\" backup");
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8; psi.StandardErrorEncoding = Encoding.UTF8;
        psi.EnvironmentVariables["TWISHA_NO_DETACH"] = "1";
        Process p = new Process(); p.StartInfo = psi;
        DataReceivedEventHandler h = delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) lock (sb) { sb.AppendLine(e.Data); } };
        p.OutputDataReceived += h; p.ErrorDataReceived += h;
        p.Start(); p.BeginOutputReadLine(); p.BeginErrorReadLine();
        if (!p.WaitForExit(240000)) { try { p.Kill(); } catch { } sb.AppendLine("(timed out)"); output = sb.ToString(); return 1; }
        p.WaitForExit();
        output = sb.ToString();
        return p.ExitCode;
    }

    /// <summary>The lines a person needs from the output of the backup (saved where; copied where; what went wrong).</summary>
    public static string Summary(string text, int code)
    {
        StringBuilder r = new StringBuilder();
        foreach (string raw in text.Replace("\r", "").Split('\n'))
        {
            string l = raw.Trim();
            if (l.Length == 0 || l.StartsWith("STEP ")) continue;
            if (l.Contains("Backup saved") || l.Contains("Also copied") || l.StartsWith("!") || l.Contains("✘") || l.StartsWith("→") || l.Contains("failed") || l.Contains("Nothing to back up"))
                r.AppendLine(l.Replace("✔", "").Replace("✘", "").Trim());
        }
        string s = r.ToString().Trim();
        if (s.Length == 0) s = code == 0 ? "Backup finished." : "The backup did not finish. Please try again.";
        return s;
    }

    public static string NewestBackup(string folder)
    {
        try
        {
            if (!Directory.Exists(folder)) return null;
            string[] files = Directory.GetFiles(folder, "TwishaPOS-*.dump");
            if (files.Length == 0) return null;
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            return files[files.Length - 1];
        }
        catch { return null; }
    }
}

class BackupForm : Form
{
    TextBox folderBox, copyBox;
    CheckBox copyCheck;
    ComboBox drives;
    Label lastBackup, copyState, status;
    ProgressBar bar;
    Button backupBtn, openBtn, closeBtn, folderBtn, copyBtn, useDriveBtn;
    TextBox result;

    public BackupForm()
    {
        Text = "Twisha POS - Backup";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = true;
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.5f);
        ClientSize = new Size(600, 500);

        Label title = new Label(); title.Text = "Back up your shop data"; title.Font = new Font("Segoe UI Semibold", 15f); title.SetBounds(20, 14, 560, 34); Controls.Add(title);
        Label hint = new Label(); hint.Text = "A backup is a safe copy of everything (bills, customers, stock). Take one every day, and keep a copy on a pen drive."; hint.SetBounds(20, 50, 560, 38); Controls.Add(hint);

        Label l1 = new Label(); l1.Text = "1. Keep backups in this folder on the laptop:"; l1.SetBounds(20, 96, 560, 22); Controls.Add(l1);
        folderBox = new TextBox(); folderBox.SetBounds(20, 120, 470, 26); folderBox.ReadOnly = true; Controls.Add(folderBox);
        folderBtn = new Button(); folderBtn.Text = "Change..."; folderBtn.SetBounds(500, 118, 80, 30); folderBtn.Click += delegate { Pick(folderBox); }; Controls.Add(folderBtn);

        copyCheck = new CheckBox(); copyCheck.Text = "2. Also put a copy of every backup on a pen drive or external disk"; copyCheck.SetBounds(20, 162, 560, 24);
        copyCheck.CheckedChanged += delegate { SyncEnabled(); }; Controls.Add(copyCheck);
        copyBox = new TextBox(); copyBox.SetBounds(20, 190, 470, 26); copyBox.ReadOnly = true; Controls.Add(copyBox);
        copyBtn = new Button(); copyBtn.Text = "Choose..."; copyBtn.SetBounds(500, 188, 80, 30); copyBtn.Click += delegate { Pick(copyBox); }; Controls.Add(copyBtn);
        Label l3 = new Label(); l3.Text = "Pen drives found:"; l3.SetBounds(20, 228, 120, 22); Controls.Add(l3);
        drives = new ComboBox(); drives.DropDownStyle = ComboBoxStyle.DropDownList; drives.SetBounds(140, 224, 350, 26); drives.DropDown += delegate { FillDrives(); }; Controls.Add(drives);
        useDriveBtn = new Button(); useDriveBtn.Text = "Use this"; useDriveBtn.SetBounds(500, 222, 80, 30);
        useDriveBtn.Click += delegate { DriveItem d = drives.SelectedItem as DriveItem; if (d != null) copyBox.Text = Path.Combine(d.Root, "TwishaPOS Backups"); };
        Controls.Add(useDriveBtn);
        Label note = new Label(); note.Text = "If the drive is not plugged in when a backup runs, the backup is still saved on the laptop and you are told."; note.SetBounds(20, 256, 560, 22); note.ForeColor = Color.DimGray; Controls.Add(note);

        lastBackup = new Label(); lastBackup.SetBounds(20, 290, 560, 22); Controls.Add(lastBackup);
        copyState = new Label(); copyState.SetBounds(20, 312, 560, 22); Controls.Add(copyState);

        backupBtn = new Button(); backupBtn.Text = "Back up now"; backupBtn.Font = new Font("Segoe UI Semibold", 11f); backupBtn.SetBounds(20, 346, 200, 44);
        backupBtn.BackColor = Color.FromArgb(22, 163, 74); backupBtn.ForeColor = Color.White; backupBtn.FlatStyle = FlatStyle.Flat; backupBtn.Click += delegate { DoBackup(); }; Controls.Add(backupBtn);
        openBtn = new Button(); openBtn.Text = "Open backup folder"; openBtn.SetBounds(232, 350, 160, 36); openBtn.Click += delegate { OpenFolder(); }; Controls.Add(openBtn);
        closeBtn = new Button(); closeBtn.Text = "Close"; closeBtn.SetBounds(500, 350, 80, 36); closeBtn.Click += delegate { SaveSettings(); Close(); }; Controls.Add(closeBtn);

        bar = new ProgressBar(); bar.Style = ProgressBarStyle.Marquee; bar.MarqueeAnimationSpeed = 25; bar.SetBounds(20, 404, 560, 12); bar.Visible = false; Controls.Add(bar);
        status = new Label(); status.SetBounds(20, 420, 560, 22); Controls.Add(status);
        result = new TextBox(); result.Multiline = true; result.ReadOnly = true; result.Font = new Font("Consolas", 9f); result.SetBounds(20, 444, 560, 44); Controls.Add(result);

        folderBox.Text = BackupProgram.Load("folder"); if (folderBox.Text.Length == 0) folderBox.Text = BackupProgram.DefaultFolder;
        copyBox.Text = BackupProgram.Load("copyTo"); copyCheck.Checked = copyBox.Text.Length > 0;
        FillDrives(); SyncEnabled(); RefreshInfo();
        FormClosing += delegate { SaveSettings(); };
    }

    class DriveItem
    {
        public string Root, Label;
        public override string ToString() { return Label; }
    }

    void FillDrives()
    {
        drives.Items.Clear();
        foreach (DriveInfo d in DriveInfo.GetDrives())
        {
            try
            {
                if (d.DriveType == DriveType.Removable && d.IsReady)
                {
                    DriveItem it = new DriveItem(); it.Root = d.RootDirectory.FullName;
                    it.Label = d.RootDirectory.FullName + "  " + (d.VolumeLabel.Length > 0 ? d.VolumeLabel : "Pen drive") + "  (" + (d.TotalSize / 1073741824L) + " GB)";
                    drives.Items.Add(it);
                }
            }
            catch { }
        }
        if (drives.Items.Count == 0) drives.Items.Add(new DriveItem { Root = "", Label = "(none found - plug it in, or use Choose...)" });
        drives.SelectedIndex = 0;
    }

    void SyncEnabled()
    {
        copyBox.Enabled = copyBtn.Enabled = drives.Enabled = useDriveBtn.Enabled = copyCheck.Checked;
        RefreshInfo();
    }

    void Pick(TextBox target)
    {
        using (FolderBrowserDialog d = new FolderBrowserDialog())
        {
            d.Description = "Choose the folder (a pen drive or external disk works too)";
            if (target.Text.Length > 0 && Directory.Exists(target.Text)) d.SelectedPath = target.Text;
            if (d.ShowDialog(this) == DialogResult.OK) target.Text = d.SelectedPath;
        }
        RefreshInfo();
    }

    void SaveSettings()
    {
        string folder = folderBox.Text == BackupProgram.DefaultFolder ? "" : folderBox.Text;
        BackupProgram.Save(folder, copyCheck.Checked ? copyBox.Text : "");
    }

    string EffectiveFolder() { return folderBox.Text.Length > 0 ? folderBox.Text : BackupProgram.DefaultFolder; }

    void RefreshInfo()
    {
        string newest = BackupProgram.NewestBackup(EffectiveFolder());
        if (newest == null) lastBackup.Text = "Last backup: none yet in this folder.";
        else { FileInfo fi = new FileInfo(newest); lastBackup.Text = "Last backup: " + fi.LastWriteTime.ToString("dd-MM-yyyy HH:mm") + "  (" + Math.Max(1, fi.Length / 1024) + " KB)"; }
        if (!copyCheck.Checked) { copyState.Text = ""; return; }
        string root = copyBox.Text.Length > 0 ? Path.GetPathRoot(copyBox.Text) : "";
        bool there = root.Length > 0 && Directory.Exists(root);
        copyState.Text = copyBox.Text.Length == 0 ? "Choose where the second copy should go." : (there ? "Second copy: " + copyBox.Text + "  (drive is connected)" : "Second copy: drive " + root + " is NOT connected right now.");
        copyState.ForeColor = (copyBox.Text.Length > 0 && !there) ? Color.OrangeRed : Color.Black;
    }

    void OpenFolder()
    {
        string f = EffectiveFolder();
        try { Directory.CreateDirectory(f); Process.Start("explorer.exe", "\"" + f + "\""); } catch { }
    }

    void DoBackup()
    {
        if (copyCheck.Checked && copyBox.Text.Length == 0) { MessageBox.Show("Choose where the second copy should go, or untick the box.", "Backup", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
        SaveSettings();
        backupBtn.Enabled = false; bar.Visible = true; status.Text = "Backing up - please wait..."; result.Text = "";
        Thread t = new Thread(delegate()
        {
            string text; int code = BackupProgram.RunBackup(out text);
            BeginInvoke((MethodInvoker)delegate
            {
                bar.Visible = false; backupBtn.Enabled = true;
                status.Text = code == 0 ? "Done." : "The backup did not finish.";
                result.Text = BackupProgram.Summary(text, code).Replace("\n", "\r\n");
                RefreshInfo();
            });
        });
        t.IsBackground = true; t.Start();
    }
}
