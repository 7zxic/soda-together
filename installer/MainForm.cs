// 安装器界面（深色，配色参考汽水音乐）
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SodaTogether
{
    static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(18, 18, 18);
        public static readonly Color Card = Color.FromArgb(30, 30, 33);
        public static readonly Color Line = Color.FromArgb(44, 44, 48);
        public static readonly Color Text = Color.FromArgb(235, 235, 235);
        public static readonly Color Sub = Color.FromArgb(140, 140, 145);
        public static readonly Color Dim = Color.FromArgb(95, 95, 100);
        public static readonly Color Green = Color.FromArgb(0, 203, 100);
        public static readonly Color GreenHover = Color.FromArgb(0, 184, 90);
        public static readonly Color Red = Color.FromArgb(255, 107, 107);
        public static readonly Color Amber = Color.FromArgb(255, 190, 80);
        public const string FontName = "Microsoft YaHei UI";

        // .NET Framework 在「系统 DPI 感知」模式下 Control.DeviceDpi 总是 96，这里直接问屏幕
        static float scale;
        public static float Scale
        {
            get
            {
                if (scale <= 0) using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
                return scale;
            }
        }

        public static GraphicsPath Round(RectangleF r, float rad)
        {
            var p = new GraphicsPath();
            float d = rad * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void Smooth(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        }
    }

    /// <summary>圆角胶囊按钮，悬停时颜色渐变</summary>
    class PillButton : Control
    {
        public Color Fill = Theme.Green, FillHover = Theme.GreenHover, Fore = Color.White;
        public bool Ghost;
        float hover; // 0..1
        bool over;
        readonly System.Windows.Forms.Timer anim = new System.Windows.Forms.Timer { Interval = 15 };

        public PillButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            anim.Tick += delegate
            {
                float target = over && Enabled ? 1f : 0f;
                hover += (target - hover) * 0.25f;
                if (Math.Abs(target - hover) < 0.01f) { hover = target; anim.Stop(); }
                Invalidate();
            };
        }
        protected override void OnMouseEnter(EventArgs e) { over = true; anim.Start(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { over = false; anim.Start(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }

        static Color Mix(Color a, Color b, float t)
        {
            return Color.FromArgb((int)(a.A + (b.A - a.A) * t), (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            Theme.Smooth(g);
            var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            var fill = Mix(Fill, FillHover, hover);
            if (!Enabled) fill = Color.FromArgb(90, fill);
            using (var path = Theme.Round(r, r.Height / 2))
            using (var b = new SolidBrush(fill))
                g.FillPath(b, path);
            var fore = Enabled ? Fore : Color.FromArgb(150, Fore);
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    /// <summary>圆形勾选框 + 文字</summary>
    class CheckRow : Control
    {
        public bool Checked = true;
        public string Hint = "";
        public event EventHandler CheckedChanged;
        public CheckRow()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
        }
        protected override void OnClick(EventArgs e)
        {
            Checked = !Checked; Invalidate();
            if (CheckedChanged != null) CheckedChanged(this, e);
            base.OnClick(e);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            Theme.Smooth(g);
            float s = Theme.Scale;
            float box = 18 * s;
            var r = new RectangleF(1, 2 * s, box, box);
            if (Checked)
            {
                using (var b = new SolidBrush(Theme.Green)) g.FillEllipse(b, r);
                using (var p = new Pen(Color.White, 2 * s) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawLines(p, new[] { new PointF(r.X + 5 * s, r.Y + 9.5f * s), new PointF(r.X + 8 * s, r.Y + 12.5f * s), new PointF(r.X + 13.5f * s, r.Y + 6 * s) });
            }
            else using (var p = new Pen(Theme.Dim, 1.5f * s)) g.DrawEllipse(p, r);
            var tx = (int)(box + 10 * s);
            TextRenderer.DrawText(g, Text, Font, new Rectangle(tx, 0, Width - tx, (int)(22 * s)), Theme.Text, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            using (var f = new Font(Theme.FontName, 8.5f))
                TextRenderer.DrawText(g, Hint, f, new Rectangle(tx, (int)(22 * s), Width - tx, Height - (int)(22 * s)), Theme.Sub, TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.WordBreak);
        }
    }

    public class MainForm : Form
    {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        readonly PillButton primary = new PillButton();
        readonly PillButton secondary = new PillButton { Ghost = true };
        readonly CheckRow takeover = new CheckRow();
        readonly LinkLabel repoLink = new LinkLabel();
        SodaInfo soda;
        string installed, bundled;
        string message = "";
        Color messageColor = Theme.Sub;
        bool busy;
        float S { get { return Theme.Scale; } }
        int Px(float v) { return (int)Math.Round(v * S); }

        public MainForm()
        {
            Text = "汽水音乐 · 一起听";
            Font = new Font(Theme.FontName, 10f);
            BackColor = Theme.Bg;
            ForeColor = Theme.Text;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = true;
            try { Icon = Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location); } catch { }

            primary.Font = new Font(Theme.FontName, 11f, FontStyle.Bold);
            primary.Click += delegate { if (!busy) Run(DoInstall); };
            secondary.Fill = Color.FromArgb(0, 0, 0, 0);
            secondary.FillHover = Color.FromArgb(40, 255, 80, 80);
            secondary.Fore = Theme.Sub;
            secondary.Font = new Font(Theme.FontName, 9.5f);
            secondary.Text = "卸载，恢复原版汽水";
            secondary.Click += delegate { if (!busy) Run(DoUninstall); };
            takeover.Font = new Font(Theme.FontName, 9.5f);
            takeover.Text = "汽水更新后自动修复（推荐）";
            takeover.Hint = "接管桌面、开始菜单、任务栏上的汽水图标：启动时如果插件因汽水更新而丢失，会自动补上。卸载时原样恢复。";
            repoLink.Text = "GitHub 开源主页";
            repoLink.LinkColor = Theme.Sub; repoLink.ActiveLinkColor = Theme.Green; repoLink.VisitedLinkColor = Theme.Sub;
            repoLink.LinkBehavior = LinkBehavior.HoverUnderline;
            repoLink.BackColor = Color.Transparent;
            repoLink.Font = new Font(Theme.FontName, 8.5f);
            repoLink.AutoSize = true;
            repoLink.LinkClicked += delegate { try { Process.Start(BuildInfo.RepoUrl); } catch { } };
            Controls.AddRange(new Control[] { primary, secondary, takeover, repoLink });
            Refresh_();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int on = 1;
            try { DwmSetWindowAttribute(Handle, 20, ref on, 4); } catch { } // 深色标题栏（Win10 2004+ / Win11）
            Layout_();
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e) { base.OnDpiChanged(e); Layout_(); }

        void Layout_()
        {
            ClientSize = new Size(Px(440), Px(640));
            int pad = Px(28), w = ClientSize.Width - pad * 2;
            takeover.SetBounds(pad, Px(334), w, Px(84));
            primary.SetBounds(pad, Px(432), w, Px(46));
            secondary.SetBounds(pad + w / 4, Px(486), w / 2, Px(32));
            repoLink.Location = new Point((ClientSize.Width - repoLink.PreferredWidth) / 2, Px(604));
            Invalidate();
        }

        void Refresh_()
        {
            soda = Patcher.Find();
            bundled = Patcher.PluginVersion();
            installed = soda == null ? null : Patcher.InstalledVersion(soda.Asar);
            primary.Enabled = soda != null;
            primary.Text = soda == null ? "未找到汽水音乐" : installed == null ? "安装" : installed != bundled ? "更新到 v" + bundled : "重新安装";
            secondary.Visible = installed != null || Shortcuts.IsTakenOver();
            if (installed != null) takeover.Checked = Shortcuts.IsTakenOver() || !System.IO.File.Exists(Shortcuts.OwnShortcut);
            Invalidate();
        }

        void Run(Action work)
        {
            if (Patcher.IsRunning())
            {
                var r = MessageBox.Show(this, "需要先关闭汽水音乐，是否继续？", Text, MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (r != DialogResult.OK) return;
            }
            busy = true;
            primary.Enabled = false; secondary.Enabled = false;
            var oldText = primary.Text;
            primary.Text = "请稍候…";
            message = ""; Invalidate();
            var t = new Thread(() =>
            {
                string err = null;
                try { work(); } catch (Exception ex) { err = ex.Message; }
                BeginInvoke((Action)(() =>
                {
                    busy = false;
                    secondary.Enabled = true;
                    if (err != null) { message = "失败：" + err; messageColor = Theme.Red; primary.Text = oldText; primary.Enabled = true; Invalidate(); }
                    else Refresh_();
                }));
            });
            t.IsBackground = true;
            t.Start();
        }

        void DoInstall()
        {
            if (Patcher.IsRunning()) Patcher.KillSoda();
            Patcher.InstallSelf();
            Patcher.Install(soda.Asar, Patcher.PluginBytes());
            string extra;
            if (takeover.Checked)
            {
                Shortcuts.RemoveOwn();
                var r = Shortcuts.TakeOver(soda);
                extra = r.Changed > 0 ? "已接管 " + r.Changed + " 个汽水快捷方式，照常打开汽水即可" : "没有找到汽水的快捷方式，已在桌面创建「汽水音乐 · 一起听」";
                if (r.Changed == 0) Shortcuts.CreateOwn(soda);
            }
            else
            {
                Shortcuts.Restore();
                Shortcuts.CreateOwn(soda);
                extra = "以后请用桌面的「汽水音乐 · 一起听」打开汽水";
            }
            Patcher.StartSoda(soda);
            SetMessage("✓ 安装完成！" + extra + "。\n在汽水顶栏点「一起听」就能开始。", Theme.Green);
        }

        void DoUninstall()
        {
            if (Patcher.IsRunning()) Patcher.KillSoda();
            int n = soda != null ? Patcher.RestoreAll(soda.BaseDir) : 0;
            int s = Shortcuts.Restore();
            Shortcuts.RemoveOwn();
            Patcher.RemoveAppDir();
            if (soda != null) Patcher.StartSoda(soda);
            SetMessage("✓ 已恢复原版汽水音乐（还原 " + n + " 个文件、" + s + " 个快捷方式）。", Theme.Green);
        }

        void SetMessage(string m, Color c) { message = m; messageColor = c; }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            Theme.Smooth(g);
            float s = S;
            int pad = Px(28), w = ClientSize.Width - pad * 2;

            // 标志：两个叠在一起的圆（头像 + 加号），和插件入口一致
            float cy = 62 * s, rad = 26 * s, cx = ClientSize.Width / 2f;
            var a = new RectangleF(cx - rad * 1.7f, cy - rad, rad * 2, rad * 2);
            var b = new RectangleF(cx - rad * 0.3f, cy - rad, rad * 2, rad * 2);
            using (var br = new LinearGradientBrush(a, Color.FromArgb(70, 70, 76), Color.FromArgb(48, 48, 52), 45f)) g.FillEllipse(br, a);
            using (var br = new SolidBrush(Theme.Bg)) g.FillEllipse(br, RectangleF.Inflate(b, 4 * s, 4 * s));
            using (var br = new SolidBrush(Theme.Green)) g.FillEllipse(br, b);
            using (var p = new Pen(Color.White, 3.2f * s) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                float px = b.X + b.Width / 2, py = b.Y + b.Height / 2, l = 9 * s;
                g.DrawLine(p, px - l, py, px + l, py);
                g.DrawLine(p, px, py - l, px, py + l);
            }

            using (var f = new Font(Theme.FontName, 17f, FontStyle.Bold))
                TextRenderer.DrawText(g, "汽水音乐 · 一起听", f, new Rectangle(0, Px(104), ClientSize.Width, Px(36)), Theme.Text, TextFormatFlags.HorizontalCenter);
            using (var f = new Font(Theme.FontName, 9.5f))
                TextRenderer.DrawText(g, "给汽水音乐电脑版加上「双人一起听」", f, new Rectangle(0, Px(146), ClientSize.Width, Px(24)), Theme.Sub, TextFormatFlags.HorizontalCenter);

            // 状态卡片
            var card = new RectangleF(pad, Px(184), w, Px(132));
            using (var path = Theme.Round(card, 14 * s))
            using (var br = new SolidBrush(Theme.Card))
                g.FillPath(br, path);
            DrawRow(g, card, 0, "汽水音乐", soda == null ? "未找到，请先安装汽水音乐" : "已找到 " + soda.Version, soda == null ? Theme.Red : Theme.Text);
            DrawRow(g, card, 1, "一起听插件", installed == null ? "未安装" : installed == bundled ? "已安装 v" + installed : "已安装 v" + installed + "（有新版本）",
                installed == null ? Theme.Sub : installed == bundled ? Theme.Green : Theme.Amber);
            DrawRow(g, card, 2, "安装器版本", "v" + bundled, Theme.Sub);

            if (!string.IsNullOrEmpty(message))
            {
                using (var f = new Font(Theme.FontName, 9f))
                    TextRenderer.DrawText(g, message, f, new Rectangle(pad, Px(526), w, Px(52)), messageColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.WordBreak);
            }
        }

        void DrawRow(Graphics g, RectangleF card, int i, string k, string v, Color vc)
        {
            float rowH = card.Height / 3;
            var r = new Rectangle((int)card.X + Px(18), (int)(card.Y + rowH * i), (int)card.Width - Px(36), (int)rowH);
            using (var f = new Font(Theme.FontName, 9.5f))
            {
                TextRenderer.DrawText(g, k, f, r, Theme.Sub, TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
                TextRenderer.DrawText(g, v, f, r, vc, TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
            if (i < 2)
                using (var p = new Pen(Theme.Line)) g.DrawLine(p, r.X, card.Y + rowH * (i + 1), r.Right, card.Y + rowH * (i + 1));
        }
    }
}
