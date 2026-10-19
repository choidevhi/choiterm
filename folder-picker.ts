// Windows' own folder picker (the Explorer-style dialog, IFileOpenDialog with FOS_PICKFOLDERS) on
// this PC's desktop, for a page opened on this PC. PowerShell compiles a few lines of C# to reach
// the COM dialog; a hidden top-most window owns it so it opens in front.
import { execFile } from 'node:child_process'

const PICK_TIMEOUT_MS = 5 * 60_000

const DIALOG_CODE = `
using System;
using System.Runtime.InteropServices;

public static class ChoiTermFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);

  const uint PICK_FOLDERS = 0x20;
  const uint FILE_SYSTEM_ONLY = 0x40;
  const uint FILE_SYSTEM_PATH = 0x80058000;

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);

  // Windows keeps a background process from taking the front; joining the input of the window in
  // front for a moment (the page that asked) lets the dialog's owner come forward.
  static void ComeForward(IntPtr owner) {
    uint front = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint mine = GetCurrentThreadId();
    bool joined = front != mine && AttachThreadInput(mine, front, true);

    BringWindowToTop(owner);
    SetForegroundWindow(owner);

    if (joined) AttachThreadInput(mine, front, false);
  }

  public static string Pick(IntPtr owner, string start, string title) {
    ComeForward(owner);

    IFileDialog dialog = (IFileDialog)new FileOpenDialog();

    dialog.SetOptions(PICK_FOLDERS | FILE_SYSTEM_ONLY);
    dialog.SetTitle(title);
    dialog.SetOkButtonLabel("폴더 선택");

    try {
      Guid shellItem = typeof(IShellItem).GUID;
      IShellItem folder;

      SHCreateItemFromParsingName(start, IntPtr.Zero, ref shellItem, out folder);
      dialog.SetFolder(folder);
    } catch {
      // Starts wherever Windows last left it.
    }

    if (dialog.Show(owner) != 0) return "";

    IShellItem result;
    string path;

    dialog.GetResult(out result);
    result.GetDisplayName(FILE_SYSTEM_PATH, out path);

    return path;
  }
}
`

// The PowerShell that shows the dialog and prints the folder picked (nothing when cancelled).
export function pickerScript(start: string, title: string): string {
  const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`

  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    `Add-Type -TypeDefinition @'\n${DIALOG_CODE}\n'@`,
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = "CenterScreen"; Width = 1; Height = 1 }',
    '$owner.Show()',
    '$owner.Activate()',
    `$picked = [ChoiTermFolderPicker]::Pick($owner.Handle, ${quote(start)}, ${quote(title)})`,
    '$owner.Close()',
    '[Console]::Out.Write($picked)',
  ].join('\n')
}

export function pickFolder(start: string, title: string): Promise<string | null> {
  const encoded = Buffer.from(pickerScript(start, title), 'utf16le').toString('base64')

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: PICK_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      const path = stdout.trim()

      resolve(error === null && path !== '' ? path : null)
    })
  })
}
