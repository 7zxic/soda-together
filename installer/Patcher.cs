// 汽水音乐 · 一起听 —— 安装逻辑（找到汽水、注入/还原 asar、接管快捷方式）
// 只使用 C# 5 语法，可以直接用 Windows 自带的 .NET Framework csc.exe 编译。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace SodaTogether
{
    public class SodaInfo
    {
        public string BaseDir;   // ...\Programs\Soda Music
        public string Asar;      // 当前生效的 main.asar
        public string Version;   // 显示用的版本号
        public string Launcher { get { return Path.Combine(BaseDir, "SodaMusicLauncher.exe"); } }
    }

    public static class Patcher
    {
        public const string Marker = "<!-- soda-together -->";
        static readonly Regex VersionRe = new Regex(@"soda-together v([0-9][0-9A-Za-z.\-]*)");

        public static string AppDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SodaTogether"); }
        }
        public static string InstalledExe { get { return Path.Combine(AppDir, "SodaTogether.exe"); } }

        // ---------------- 插件（嵌入在 exe 里） ----------------
        public static byte[] PluginBytes()
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("soda-together.js"))
            using (var ms = new MemoryStream())
            {
                if (s == null) throw new Exception("安装器损坏：缺少插件资源");
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }
        public static string PluginVersion()
        {
            var head = Encoding.UTF8.GetString(PluginBytes(), 0, 200);
            var m = VersionRe.Match(head);
            return m.Success ? m.Groups[1].Value : "?";
        }

        // ---------------- 找到汽水 ----------------
        public static SodaInfo Find()
        {
            var candidates = new List<string>();
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Soda Music"));
            foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
            {
                foreach (var path in new[] { @"Software\Microsoft\Windows\CurrentVersion\Uninstall", @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" })
                {
                    try
                    {
                        using (var k = root.OpenSubKey(path))
                        {
                            if (k == null) continue;
                            foreach (var name in k.GetSubKeyNames())
                            {
                                using (var sk = k.OpenSubKey(name))
                                {
                                    if (sk == null) continue;
                                    var dn = sk.GetValue("DisplayName") as string;
                                    var loc = sk.GetValue("InstallLocation") as string;
                                    if (dn == "汽水音乐" && !string.IsNullOrEmpty(loc)) candidates.Add(loc);
                                }
                            }
                        }
                    }
                    catch { }
                }
            }
            foreach (var c in candidates)
            {
                if (string.IsNullOrEmpty(c) || !File.Exists(Path.Combine(c, "launcher_config.json"))) continue;
                var info = new SodaInfo { BaseDir = c.TrimEnd('\\') };
                // 汽水会把界面热更新包放在 Packages\<版本>\，存在时优先加载它
                var pkgCfg = Path.Combine(c, @"Packages\config.json");
                if (File.Exists(pkgCfg))
                {
                    var v = JsonString(File.ReadAllText(pkgCfg, Encoding.UTF8), "latestVersion");
                    if (!string.IsNullOrEmpty(v) && File.Exists(Path.Combine(c, @"Packages\" + v + @"\main.asar")))
                    {
                        info.Asar = Path.Combine(c, @"Packages\" + v + @"\main.asar");
                        info.Version = v;
                        return info;
                    }
                }
                var cur = JsonString(File.ReadAllText(Path.Combine(c, "launcher_config.json"), Encoding.UTF8), "cur_path");
                if (string.IsNullOrEmpty(cur)) continue;
                info.Asar = Path.Combine(c, cur + @"\resources\main.asar");
                info.Version = cur;
                if (File.Exists(info.Asar)) return info;
            }
            return null;
        }

        static string JsonString(string json, string key)
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"");
            return m.Success ? m.Groups[1].Value : null;
        }

        public static bool IsRunning() { return Process.GetProcessesByName("SodaMusic").Length > 0; }

        public static void KillSoda()
        {
            foreach (var p in Process.GetProcessesByName("SodaMusic"))
            {
                try { p.Kill(); } catch { }
            }
            for (int i = 0; i < 50 && IsRunning(); i++) Thread.Sleep(100);
            Thread.Sleep(800); // 等文件句柄释放
        }

        public static void StartSoda(SodaInfo s)
        {
            Process.Start(new ProcessStartInfo(s.Launcher) { WorkingDirectory = s.BaseDir, UseShellExecute = true });
        }

        // ---------------- asar ----------------
        class Asar
        {
            public byte[] Bytes;
            public string Json;
            public long DataBase;
        }
        class Entry
        {
            public int Index, Length; // 在 JSON 字符串里的位置
            public long Size, Offset;
        }

        static Asar ReadAsar(string path)
        {
            var b = File.ReadAllBytes(path);
            if (b.Length < 16 || BitConverter.ToUInt32(b, 0) != 4) throw new Exception("不认识的 asar 文件格式");
            var headerPickleSize = BitConverter.ToUInt32(b, 4);
            var jsonLen = (int)BitConverter.ToUInt32(b, 12);
            return new Asar { Bytes = b, Json = Encoding.UTF8.GetString(b, 16, jsonLen), DataBase = 8L + headerPickleSize };
        }

        // 不做完整 JSON 解析，只定位某个文件那一条记录
        static Entry FindEntry(string json, string name)
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(name) + "\":(\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)?\\})");
            if (!m.Success) return null;
            var body = m.Groups[1].Value;
            var size = Regex.Match(body, "\"size\":(\\d+)");
            var off = Regex.Match(body, "\"offset\":\"(\\d+)\"");
            if (!size.Success || !off.Success) return null;
            return new Entry { Index = m.Groups[1].Index, Length = m.Groups[1].Length, Size = long.Parse(size.Groups[1].Value), Offset = long.Parse(off.Groups[1].Value) };
        }

        static byte[] EntryBytes(Asar a, Entry e)
        {
            var o = new byte[e.Size];
            Array.Copy(a.Bytes, a.DataBase + e.Offset, o, 0, e.Size);
            return o;
        }

        static string EntryScriptName(Asar a)
        {
            var html = FindEntry(a.Json, "main.html");
            if (html == null) throw new Exception("找不到 main.html，这个版本的汽水可能不兼容");
            var text = Encoding.UTF8.GetString(EntryBytes(a, html));
            var m = Regex.Match(text, "<script type=\"module\"[^>]*src=\"\\./([^\"]+)\"");
            if (!m.Success) throw new Exception("找不到入口脚本，这个版本的汽水可能不兼容");
            var parts = m.Groups[1].Value.Split('/');
            return parts[parts.Length - 1];
        }

        /// <summary>返回已安装的插件版本；未安装返回 null</summary>
        public static string InstalledVersion(string asarPath)
        {
            try
            {
                var a = ReadAsar(asarPath);
                var e = FindEntry(a.Json, EntryScriptName(a));
                if (e == null) return null;
                var head = Encoding.UTF8.GetString(a.Bytes, (int)(a.DataBase + e.Offset), (int)Math.Min(200, e.Size));
                if (!head.Contains(Marker)) return null;
                var m = VersionRe.Match(head);
                return m.Success ? m.Groups[1].Value : "旧版";
            }
            catch { return null; }
        }

        static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }

        static string Integrity(byte[] data)
        {
            const int block = 4194304;
            using (var sha = SHA256.Create())
            {
                var blocks = new List<string>();
                for (int i = 0; i < data.Length; i += block)
                    blocks.Add("\"" + Hex(sha.ComputeHash(data, i, Math.Min(block, data.Length - i))) + "\"");
                return "{\"algorithm\":\"SHA256\",\"hash\":\"" + Hex(sha.ComputeHash(data)) + "\",\"blockSize\":" + block + ",\"blocks\":[" + string.Join(",", blocks) + "]}";
            }
        }

        /// <summary>
        /// 注入插件：把「插件 + 原入口脚本」追加到 asar 末尾，再把入口脚本的记录指过去。
        /// 其余文件的数据和偏移完全不变。总是基于备份的原始文件（main.asar.orig）来生成。
        /// </summary>
        public static void Install(string asarPath, byte[] plugin)
        {
            var orig = asarPath + ".orig";
            if (!File.Exists(orig))
            {
                if (InstalledVersion(asarPath) != null) throw new Exception("发现已被修改但没有备份的文件，请重新安装汽水音乐后再试");
                File.Copy(asarPath, orig);
            }
            var a = ReadAsar(orig);
            var name = EntryScriptName(a);
            var e = FindEntry(a.Json, name);
            if (e == null) throw new Exception("找不到入口脚本 " + name);
            var origScript = EntryBytes(a, e);
            var newScript = new byte[plugin.Length + origScript.Length];
            Buffer.BlockCopy(plugin, 0, newScript, 0, plugin.Length);
            Buffer.BlockCopy(origScript, 0, newScript, plugin.Length, origScript.Length);

            long dataLen = a.Bytes.Length - a.DataBase;
            var newEntry = "{\"size\":" + newScript.Length + ",\"offset\":\"" + dataLen + "\",\"integrity\":" + Integrity(newScript) + "}";
            var json = a.Json.Substring(0, e.Index) + newEntry + a.Json.Substring(e.Index + e.Length);
            var jb = Encoding.UTF8.GetBytes(json);
            int pad = (4 - jb.Length % 4) % 4;

            var tmp = asarPath + ".tmp";
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
            using (var w = new BinaryWriter(fs))
            {
                w.Write((uint)4);
                w.Write((uint)(8 + jb.Length + pad));
                w.Write((uint)(4 + jb.Length + pad));
                w.Write((uint)jb.Length);
                w.Write(jb);
                w.Write(new byte[pad]);
                w.Write(a.Bytes, (int)a.DataBase, (int)dataLen);
                w.Write(newScript);
            }
            File.Copy(tmp, asarPath, true);
            File.Delete(tmp);
        }

        /// <summary>把汽水目录下所有 main.asar.orig 还原回去</summary>
        public static int RestoreAll(string baseDir)
        {
            int n = 0;
            foreach (var orig in Directory.GetFiles(baseDir, "main.asar.orig", SearchOption.AllDirectories))
            {
                var target = orig.Substring(0, orig.Length - ".orig".Length);
                File.Copy(orig, target, true);
                File.Delete(orig);
                n++;
            }
            return n;
        }

        // ---------------- 自身安装位置 ----------------
        /// <summary>把自己复制到 %LOCALAPPDATA%\SodaTogether，快捷方式都指向这里</summary>
        public static void InstallSelf()
        {
            Directory.CreateDirectory(AppDir);
            var me = Assembly.GetExecutingAssembly().Location;
            if (string.Equals(Path.GetFullPath(me), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase)) return;
            File.Copy(me, InstalledExe, true);
        }

        static bool RunningFromAppDir()
        {
            var me = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            return me.StartsWith(Path.GetFullPath(AppDir) + "\\", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>删除 %LOCALAPPDATA%\SodaTogether。如果自己就是从那里运行的，等本进程退出后再删。</summary>
        public static void RemoveAppDir()
        {
            if (!Directory.Exists(AppDir)) return;
            if (!RunningFromAppDir())
            {
                try { Directory.Delete(AppDir, true); } catch { }
                return;
            }
            try
            {
                var pid = Process.GetCurrentProcess().Id;
                var ps = "Wait-Process -Id " + pid + " -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath '" + AppDir.Replace("'", "''") + "' -Recurse -Force -ErrorAction SilentlyContinue";
                Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -WindowStyle Hidden -Command \"" + ps + "\"")
                { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch { }
        }
    }
}
