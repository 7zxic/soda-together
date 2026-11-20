// 接管汽水的快捷方式：桌面 / 开始菜单 / 任务栏上的汽水图标改为先经过 SodaTogether.exe --launch，
// 汽水自动更新导致插件丢失时会自动补上。所有改动都记录下来，卸载时原样恢复。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace SodaTogether
{
    public static class Shortcuts
    {
        const string LaunchArg = "--launch";
        static string StateFile { get { return Path.Combine(Patcher.AppDir, "shortcuts.txt"); } }
        public static string OwnShortcut
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "汽水音乐 · 一起听.lnk"); }
        }

        static dynamic Shell() { return Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")); }

        static IEnumerable<string> Folders()
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            yield return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            yield return Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
            yield return Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            yield return Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
            yield return Path.Combine(appData, @"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar");
            yield return Path.Combine(appData, @"Microsoft\Internet Explorer\Quick Launch");
        }

        static IEnumerable<string> LinkFiles()
        {
            foreach (var f in Folders())
            {
                if (string.IsNullOrEmpty(f) || !Directory.Exists(f)) continue;
                string[] files;
                try { files = Directory.GetFiles(f, "*.lnk", SearchOption.AllDirectories); } catch { continue; }
                foreach (var x in files) yield return x;
            }
        }

        public class Result { public int Changed; public int Skipped; }

        /// <summary>把指向汽水启动器的快捷方式改为指向我们的 --launch</summary>
        public static Result TakeOver(SodaInfo soda)
        {
            var r = new Result();
            var shell = Shell();
            var records = new List<string>(ReadState());
            foreach (var lnk in LinkFiles())
            {
                try
                {
                    var sc = shell.CreateShortcut(lnk);
                    string target = sc.TargetPath;
                    if (!string.Equals(target, soda.Launcher, StringComparison.OrdinalIgnoreCase)) continue;
                    records.Add(string.Join("\t", new[] { lnk, (string)sc.TargetPath, (string)sc.Arguments, (string)sc.WorkingDirectory, (string)sc.IconLocation }));
                    sc.TargetPath = Patcher.InstalledExe;
                    sc.Arguments = LaunchArg;
                    sc.WorkingDirectory = Patcher.AppDir;
                    string icon = sc.IconLocation;
                    if (string.IsNullOrEmpty(icon) || icon.StartsWith(",")) sc.IconLocation = soda.Launcher + ",0";
                    sc.Save();
                    r.Changed++;
                }
                catch (UnauthorizedAccessException) { r.Skipped++; }
                catch (Exception) { r.Skipped++; }
            }
            WriteState(records);
            return r;
        }

        /// <summary>恢复所有被接管的快捷方式</summary>
        public static int Restore()
        {
            int n = 0;
            var shell = Shell();
            foreach (var line in ReadState())
            {
                var p = line.Split('\t');
                if (p.Length < 5 || !File.Exists(p[0])) continue;
                try
                {
                    var sc = shell.CreateShortcut(p[0]);
                    sc.TargetPath = p[1]; sc.Arguments = p[2]; sc.WorkingDirectory = p[3]; sc.IconLocation = p[4];
                    sc.Save();
                    n++;
                }
                catch { }
            }
            try { File.Delete(StateFile); } catch { }
            return n;
        }

        public static bool IsTakenOver()
        {
            foreach (var line in ReadState())
            {
                var p = line.Split('\t');
                if (p.Length >= 5 && File.Exists(p[0])) return true;
            }
            return false;
        }

        /// <summary>不接管时，单独在桌面放一个「汽水音乐 · 一起听」</summary>
        public static void CreateOwn(SodaInfo soda)
        {
            var sc = Shell().CreateShortcut(OwnShortcut);
            sc.TargetPath = Patcher.InstalledExe;
            sc.Arguments = LaunchArg;
            sc.WorkingDirectory = Patcher.AppDir;
            sc.IconLocation = soda.Launcher + ",0";
            sc.Description = "启动带「一起听」的汽水音乐";
            sc.Save();
        }

        public static void RemoveOwn() { try { File.Delete(OwnShortcut); } catch { } }

        static IEnumerable<string> ReadState()
        {
            if (!File.Exists(StateFile)) return new string[0];
            return File.ReadAllLines(StateFile, Encoding.UTF8);
        }

        static void WriteState(List<string> lines)
        {
            Directory.CreateDirectory(Patcher.AppDir);
            // 同一个快捷方式只保留第一次记录（那才是原始状态）
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var outLines = new List<string>();
            foreach (var l in lines)
            {
                var key = l.Split('\t')[0];
                if (seen.Add(key)) outLines.Add(l);
            }
            File.WriteAllLines(StateFile, outLines, Encoding.UTF8);
        }
    }
}
