// MyWhatsapp Windows launcher.
//
// Compiled with the .NET Framework C# compiler that ships with Windows, so the build
// needs no Visual Studio, no admin rights and no extra tooling:
//   csc.exe /target:winexe /r:System.Windows.Forms.dll /out:MyWhatsapp.exe Launcher.cs
//
// Deliberately C# 5 compatible (no interpolation, no ?. , no expression-bodied members)
// because .NET Framework 4.x ships the pre-Roslyn compiler.
//
// Responsibilities:
//   - start runtime\node.exe app\dist\main.js as a hidden background process,
//   - stream its stdout/stderr into data\logs\mywhatsapp.log,
//   - wait for the API to answer /api/health, then open the dashboard in the browser,
//   - surface the generated admin API key once, on first run,
//   - hold the child for its lifetime and clean up the pid file on exit.
//
// Pass --stop to terminate a running instance (used by the "Stop MyWhatsapp" shortcut and by
// install.ps1). Add --quiet to suppress the message box; the outcome goes to
// data\logs\mywhatsapp.log and the exit code (0 stopped, 2 nothing to stop) instead.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MyWhatsapp
{
    internal static class Program
    {
        private const int Port = 2785;

        private static string _root;
        private static string _nodeExe;
        private static string _appDir;
        private static string _dataDir;
        private static string _logDir;
        private static string _logFile;
        private static string _pidFile;

        private static readonly object _logLock = new object();
        private static StreamWriter _logWriter;

        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();

            _root = AppDomain.CurrentDomain.BaseDirectory;
            _nodeExe = Path.Combine(_root, Path.Combine("runtime", "node.exe"));
            _appDir = Path.Combine(_root, "app");
            _dataDir = Path.Combine(_appDir, "data");
            _logDir = Path.Combine(_dataDir, "logs");
            _logFile = Path.Combine(_logDir, "mywhatsapp.log");
            _pidFile = Path.Combine(_dataDir, "mywhatsapp.pid");

            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--stop", StringComparison.OrdinalIgnoreCase))
                {
                    return Stop(HasArg(args, "--quiet"));
                }
            }

            try
            {
                Directory.CreateDirectory(_dataDir);
                Directory.CreateDirectory(_logDir);
                Directory.CreateDirectory(Path.Combine(_dataDir, "plugins"));
                Directory.CreateDirectory(Path.Combine(_dataDir, "puppeteer"));
            }
            catch (Exception ex)
            {
                Fail("Could not prepare the data directory under " + _dataDir + ".\r\n\r\n" + ex.Message);
                return 1;
            }

            if (!File.Exists(_nodeExe))
            {
                Fail("The bundled Node runtime is missing:\r\n" + _nodeExe + "\r\n\r\nReinstall MyWhatsapp.");
                return 1;
            }

            // Second launch of the shortcut: our own instance is already up, so just show the UI.
            if (IsOurInstanceRunning())
            {
                OpenBrowser();
                return 0;
            }

            // The pid file lives inside app\data, which an upgrade replaces wholesale - so a
            // running instance can outlive its own pid file. Recover the pid from whoever holds
            // the port before concluding that a foreign program owns it; otherwise every upgrade
            // leaves the next launch claiming "port 2785 is in use by another program".
            int ownerPid = IsPortOpen() ? GetPortOwnerPid() : 0;
            if (ownerPid != 0 && IsOurBundledNode(ownerPid) && IsLauncherRunning())
            {
                WritePid(ownerPid);
                OpenBrowser();
                return 0;
            }

            // Port busy but no live instance of ours: something else owns 2785. Starting anyway
            // would produce a confusing EADDRINUSE crash, so say so instead.
            if (IsPortOpen())
            {
                Fail(PortBusyMessage(ownerPid));
                return 1;
            }

            OpenLog();

            Process proc = StartNode();
            if (proc == null)
            {
                Fail("Could not start the bundled Node runtime:\r\n" + _nodeExe);
                CloseLog();
                return 1;
            }

            WritePid(proc.Id);

            if (!WaitForHealth(150))
            {
                bool exited = proc.HasExited;
                int code = exited ? proc.ExitCode : -1;
                Fail(
                    "MyWhatsapp did not finish starting within the startup window" +
                    (exited ? (" (node exited with code " + code + ")") : "") +
                    ".\r\n\r\nLast log lines:\r\n\r\n" + LogTail(25));
                CloseLog();
                return 1;
            }

            RevealFirstRunKey();
            OpenBrowser();

            proc.WaitForExit();
            TryDeletePid();
            CloseLog();
            return 0;
        }

        private static Process StartNode()
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _nodeExe;
            psi.Arguments = "\"dist\\main.js\"";
            psi.WorkingDirectory = _appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            // These are passed as process env vars, so they win over app\.env (dotenv never
            // overrides an already-set variable) and the per-user paths stay correct even if the
            // installed .env is edited later.
            // .NET Framework exposes EnvironmentVariables as a StringDictionary (not NameValueCollection).
            System.Collections.Specialized.StringDictionary env = psi.EnvironmentVariables;
            env["PORT"] = Port.ToString();
            // Left in development on purpose: unset/development is the documented local-run mode,
            // and it is what keeps the production secret guard (API_MASTER_KEY / ALLOW_DEV_API_KEY
            // checks) from refusing to boot a single-user desktop install.
            env["NODE_ENV"] = "development";
            env["DATABASE_TYPE"] = "sqlite";
            env["SERVE_DASHBOARD"] = "true";
            env["PLUGINS_DIR"] = "./data/plugins";
            // Chromium must land somewhere the user can write, and must not pollute the global
            // puppeteer cache - this is what makes "Chromium downloads on first run" work.
            env["PUPPETEER_CACHE_DIR"] = Path.Combine(_dataDir, "puppeteer");
            env["ELECTRON_ENABLE_LOGGING"] = "0";
            env.Remove("NODE_OPTIONS");
            env.Remove("NODE_PATH");

            try
            {
                Process proc = new Process();
                proc.StartInfo = psi;
                proc.EnableRaisingEvents = true;
                proc.OutputDataReceived += OnNodeOutput;
                proc.ErrorDataReceived += OnNodeOutput;
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                return proc;
            }
            catch (Exception ex)
            {
                Append("launcher: failed to start node: " + ex.Message);
                return null;
            }
        }

        private static void OnNodeOutput(object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null)
            {
                Append(e.Data);
            }
        }

        private static bool IsPortOpen()
        {
            try
            {
                TcpProbe probe = new TcpProbe();
                return probe.Open(Port, 400);
            }
            catch
            {
                return false;
            }
        }

        // True only when the pid we recorded is still a live node process - i.e. the instance this
        // launcher owns. Guards against a recycled pid and against another program owning the port.
        private static bool IsOurInstanceRunning()
        {
            int pid;
            return TryReadPid(out pid) && IsAliveNode(pid);
        }

        private static bool IsAliveNode(int pid)
        {
            if (pid <= 0)
            {
                return false;
            }
            try
            {
                Process proc = Process.GetProcessById(pid);
                return !proc.HasExited &&
                       string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        // True only for a node.exe that belongs to *this* payload, i.e. one shipped in a
        // <payload>\runtime folder. A developer running `npm run start:dev` uses the system
        // node.exe, so this never mistakes a dev server for an installed instance.
        private static bool IsOurBundledNode(int pid)
        {
            try
            {
                Process proc = Process.GetProcessById(pid);
                if (!string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
                string expected = Path.Combine(_root, Path.Combine("runtime", "node.exe"));
                return string.Equals(proc.MainModule.FileName, expected, StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        private static bool IsLauncherRunning()
        {
            try
            {
                string self = Path.Combine(_root, "MyWhatsapp.exe");
                Process[] all = Process.GetProcessesByName("MyWhatsapp");
                for (int i = 0; i < all.Length; i++)
                {
                    try
                    {
                        if (string.Equals(all[i].MainModule.FileName, self, StringComparison.OrdinalIgnoreCase))
                        {
                            return true;
                        }
                    }
                    catch
                    {
                    }
                }
            }
            catch
            {
            }
            return false;
        }

        // Pid of whatever is listening on Port, or 0. netstat -ano is used rather than
        // IPGlobalProperties because the listener is bound to "::" here, where the managed API
        // exposes the socket but not the owning pid.
        private static int GetPortOwnerPid()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "netstat";
                psi.Arguments = "-ano -p TCP";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;

                using (Process proc = Process.Start(psi))
                {
                    string stdout = proc.StandardOutput.ReadToEnd();
                    proc.WaitForExit(10000);

                    string suffix = ":" + Port.ToString();
                    string[] lines = stdout.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    for (int i = 0; i < lines.Length; i++)
                    {
                        string[] cols = lines[i].Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                        // Proto, LocalAddress, ForeignAddress, State, PID. The state name is
                        // localised, so the local address is what identifies the listener.
                        if (cols.Length < 5 || !cols[1].EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                        int pid;
                        if (int.TryParse(cols[cols.Length - 1], out pid) && pid != 0)
                        {
                            return pid;
                        }
                    }
                }
            }
            catch
            {
            }
            return 0;
        }

        private static bool WaitForPortFree(int seconds)
        {
            DateTime deadline = DateTime.Now.AddSeconds(seconds);
            while (DateTime.Now < deadline)
            {
                if (!IsPortOpen())
                {
                    return true;
                }
                Thread.Sleep(250);
            }
            return !IsPortOpen();
        }

        private static string PortBusyMessage(int ownerPid)
        {
            string owner = "another program";
            if (ownerPid != 0)
            {
                try
                {
                    Process proc = Process.GetProcessById(ownerPid);
                    owner = proc.ProcessName + " (pid " + ownerPid + ")";
                    try
                    {
                        owner += "\r\n" + proc.MainModule.FileName;
                    }
                    catch
                    {
                    }
                }
                catch
                {
                    owner = "pid " + ownerPid;
                }
            }
            return "Port " + Port + " is already in use by " + owner +
                   ", so MyWhatsapp cannot start.\r\n\r\nClose it, then launch MyWhatsapp again." +
                   "\r\n\r\nIf it is a leftover MyWhatsapp instance, run \"Stop MyWhatsapp\" from" +
                   " the Start Menu - or re-run packaging\\windows\\install.ps1, which stops it" +
                   " for you.\r\n\r\nIf that fails, the process is probably running as" +
                   " administrator: open PowerShell as Administrator and run" +
                   "   Stop-Process -Id " + (ownerPid != 0 ? ownerPid.ToString() : "<pid>") + " -Force" +
                   "\r\n\r\nTo find it yourself:  netstat -ano | findstr " + Port;
        }

        private static bool WaitForHealth(int seconds)
        {
            DateTime deadline = DateTime.Now.AddSeconds(seconds);
            while (DateTime.Now < deadline)
            {
                if (IsPortOpen())
                {
                    try
                    {
                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                            "http://127.0.0.1:" + Port + "/api/health");
                        req.Method = "GET";
                        req.Timeout = 3000;
                        using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                        {
                            int status = (int)res.StatusCode;
                            if (status >= 200 && status < 400)
                            {
                                return true;
                            }
                        }
                    }
                    catch
                    {
                        // Listening but not answering yet - keep waiting.
                    }
                }
                Thread.Sleep(1500);
            }
            return false;
        }

        private static void RevealFirstRunKey()
        {
            string keyFile = Path.Combine(_dataDir, ".api-key");
            string marker = Path.Combine(_dataDir, ".first-run-revealed");
            if (!File.Exists(keyFile) || File.Exists(marker))
            {
                return;
            }

            string key;
            try
            {
                key = (File.ReadAllText(keyFile) ?? string.Empty).Trim();
            }
            catch
            {
                return;
            }
            if (key.Length == 0)
            {
                return;
            }

            try
            {
                File.WriteAllText(marker, DateTime.Now.ToString("o"));
            }
            catch
            {
                // Non-fatal: worst case the key is shown again next launch.
            }

            bool copied = false;
            try
            {
                Clipboard.SetText(key);
                copied = true;
            }
            catch
            {
                // Clipboard can be locked by another process; the key is shown either way.
            }

            MessageBox.Show(
                "MyWhatsapp is running.\r\n\r\n" +
                "Sign in to the dashboard with this API key:\r\n\r\n" + key + "\r\n\r\n" +
                (copied ? "It has been copied to your clipboard. " : "") +
                "It is also stored at:\r\n" + keyFile,
                "MyWhatsapp - first run",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        private static int Stop(bool quiet)
        {
            int pid;
            if (!TryReadPid(out pid) || !IsAliveNode(pid))
            {
                // The pid file is gone or stale, which is exactly the state an upgrade leaves
                // behind. Fall back to the port owner, but only accept it when it is one of our
                // bundled runtimes - never kill an unrelated program just because it holds 2785.
                pid = IsPortOpen() ? GetPortOwnerPid() : 0;
            }

            bool stopped = false;
            string message;
            if (pid != 0 && IsAliveNode(pid) && IsOurBundledNode(pid))
            {
                try
                {
                    Process proc = Process.GetProcessById(pid);
                    proc.Kill();
                    proc.WaitForExit(15000);
                    stopped = true;
                    message = "MyWhatsapp has been stopped.";
                }
                catch (Exception ex)
                {
                    message = "MyWhatsapp could not be stopped: " + ex.Message;
                }
                TryDeletePid();
                // The installer copies over the folder this launcher lives in, so it needs the
                // port released before it can replace anything.
                if (!WaitForPortFree(15))
                {
                    message += "\r\n\r\nPort " + Port + " is still in use.";
                }
            }
            else if (pid != 0 && IsAliveNode(pid))
            {
                message = "Port " + Port + " is held by " + pid +
                          ", which is not a MyWhatsapp instance. Close it manually.";
            }
            else
            {
                message = "MyWhatsapp is not running.";
            }

            if (quiet)
            {
                // A /target:winexe has no console of its own, so Console.WriteLine would go
                // nowhere. The log is the only channel a caller can actually read, and the exit
                // code (0 stopped, 2 nothing to stop) carries the result.
                OpenLog();
                Append("[launcher] --stop: " + message.Replace("\r\n", " "));
                CloseLog();
                return stopped ? 0 : 2;
            }

            MessageBox.Show(
                message,
                "MyWhatsapp",
                MessageBoxButtons.OK,
                stopped ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            return stopped ? 0 : 2;
        }

        private static bool HasArg(string[] args, string name)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static void OpenBrowser()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "http://localhost:" + Port;
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                Fail("Could not open your browser.\r\n\r\nOpen http://localhost:" + Port +
                     " manually.\r\n\r\n" + ex.Message);
            }
        }

        private static void OpenLog()
        {
            try
            {
                _logWriter = new StreamWriter(_logFile, true, Encoding.UTF8);
                _logWriter.AutoFlush = true;
            }
            catch
            {
                _logWriter = null;
            }
        }

        private static void CloseLog()
        {
            lock (_logLock)
            {
                if (_logWriter != null)
                {
                    try { _logWriter.Dispose(); } catch { }
                    _logWriter = null;
                }
            }
        }

        private static void Append(string line)
        {
            lock (_logLock)
            {
                if (_logWriter == null)
                {
                    return;
                }
                try
                {
                    _logWriter.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line);
                }
                catch
                {
                }
            }
        }

        private static string LogTail(int lines)
        {
            try
            {
                List<string> all = new List<string>(File.ReadAllLines(_logFile));
                int from = Math.Max(0, all.Count - lines);
                StringBuilder sb = new StringBuilder();
                for (int i = from; i < all.Count; i++)
                {
                    sb.AppendLine(all[i]);
                }
                return sb.ToString();
            }
            catch (Exception ex)
            {
                return "(could not read " + _logFile + ": " + ex.Message + ")";
            }
        }

        private static void WritePid(int pid)
        {
            try
            {
                File.WriteAllText(_pidFile, pid.ToString());
            }
            catch
            {
            }
        }

        private static bool TryReadPid(out int pid)
        {
            pid = 0;
            try
            {
                if (!File.Exists(_pidFile))
                {
                    return false;
                }
                return int.TryParse((File.ReadAllText(_pidFile) ?? string.Empty).Trim(), out pid);
            }
            catch
            {
                return false;
            }
        }

        private static void TryDeletePid()
        {
            try
            {
                if (File.Exists(_pidFile))
                {
                    File.Delete(_pidFile);
                }
            }
            catch
            {
            }
        }

        private static void Fail(string message)
        {
            MessageBox.Show(
                message,
                "MyWhatsapp - startup failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    internal sealed class TcpProbe
    {
        public bool Open(int port, int timeoutMs)
        {
            try
            {
                System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient();
                IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(timeoutMs, false))
                {
                    client.Close();
                    return false;
                }
                client.EndConnect(ar);
                client.Close();
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}