// 入口
//   SodaTogether.exe              打开安装界面
//   SodaTogether.exe --launch     （快捷方式用）插件丢失或过旧时自动补上，然后启动汽水；不显示任何窗口
//   SodaTogether.exe --install [--no-takeover]   静默安装
//   SodaTogether.exe --uninstall  静默卸载
using System;
using System.Linq;
using System.Windows.Forms;

namespace SodaTogether
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Contains("--launch")) return Launch();
            if (args.Contains("--install")) return Silent(true, !args.Contains("--no-takeover"));
            if (args.Contains("--uninstall")) return Silent(false, false);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
            return 0;
        }

        static int Launch()
        {
            SodaInfo soda = null;
            try
            {
                soda = Patcher.Find();
                if (soda == null) return 1;
                if (!Patcher.IsRunning())
                {
                    var v = Patcher.InstalledVersion(soda.Asar);
                    // 汽水更新到新版本后插件会丢：这里自动补上；插件版本落后时顺便更新
                    if (v == null || v != Patcher.PluginVersion()) Patcher.Install(soda.Asar, Patcher.PluginBytes());
                }
            }
            catch { /* 修复失败也照常启动汽水，不影响听歌 */ }
            try { if (soda != null) Patcher.StartSoda(soda); } catch { }
            return 0;
        }

        static int Silent(bool install, bool takeover)
        {
            try
            {
                var soda = Patcher.Find();
                if (soda == null) { Console.Error.WriteLine("没有找到汽水音乐"); return 1; }
                if (Patcher.IsRunning()) Patcher.KillSoda();
                if (install)
                {
                    Patcher.InstallSelf();
                    Patcher.Install(soda.Asar, Patcher.PluginBytes());
                    if (takeover && Shortcuts.TakeOver(soda).Changed > 0) Shortcuts.RemoveOwn();
                    else Shortcuts.CreateOwn(soda);
                }
                else
                {
                    Patcher.RestoreAll(soda.BaseDir);
                    Shortcuts.Restore();
                    Shortcuts.RemoveOwn();
                    Patcher.RemoveAppDir();
                }
                return 0;
            }
            catch (Exception e) { Console.Error.WriteLine(e.Message); return 2; }
        }
    }
}
