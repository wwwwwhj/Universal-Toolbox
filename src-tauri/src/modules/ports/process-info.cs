using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class PortProcessInfo
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(SafeProcessHandle process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsWow64Process(SafeProcessHandle process, out bool wow64);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(SafeProcessHandle process, int kind, byte[] buffer, int size, out int returned);
    [DllImport("ntdll.dll")]
    static extern int NtQuerySystemInformation(int kind, IntPtr buffer, int size, out int returned);

    public sealed class ProcessIdentity
    {
        public string Name;
        public long CreateTicks;
        public int ParentPid;
    }

    public sealed class ProcessDetails
    {
        public string WorkingDirectory;
        public string WorkingDirectoryError;
        public string ImagePath;
        public string CommandLine;
    }

    // SystemProcessInformation 一次返回全部进程的名称、创建时间和父进程，
    // 替代逐进程访问 Process.StartTime / Path（每次访问都要 OpenProcess，近百进程需要数秒）。
    // ponytail: SYSTEM_PROCESS_INFORMATION 布局不是稳定公共接口；当前仅覆盖 x64。
    // 布局依据：https://github.com/winsiderss/phnt （psutil 同样使用）
    public static Dictionary<int, ProcessIdentity> Snapshot()
    {
        if (IntPtr.Size != 8) throw new NotSupportedException("进程快照需要 64 位工具箱。");
        int size = 1 << 20;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            int returned;
            while (true)
            {
                int status = NtQuerySystemInformation(5, buffer, size, out returned);
                if (status == unchecked((int)0xC0000004)) // STATUS_INFO_LENGTH_MISMATCH
                {
                    Marshal.FreeHGlobal(buffer);
                    size *= 2;
                    buffer = Marshal.AllocHGlobal(size);
                    continue;
                }
                if (status < 0) throw new InvalidOperationException("进程快照查询失败：0x" + status.ToString("X8"));
                break;
            }
            var map = new Dictionary<int, ProcessIdentity>();
            int offset = 0;
            while (offset + 0x60 <= size)
            {
                IntPtr entry = new IntPtr(buffer.ToInt64() + offset);
                int next = Marshal.ReadInt32(entry);
                if (next < 0 || next > size - offset) break;
                long created = Marshal.ReadInt64(entry, 0x20);
                int nameLength = Marshal.ReadInt16(entry, 0x38);
                IntPtr nameAddress = Marshal.ReadIntPtr(entry, 0x40);
                string name = nameLength > 0 && nameLength <= 1024 && nameAddress != IntPtr.Zero
                    ? Marshal.PtrToStringUni(nameAddress, nameLength / 2)
                    : "";
                long pid = Marshal.ReadInt64(entry, 0x50);
                long parent = Marshal.ReadInt64(entry, 0x58);
                if (pid > 0 && pid <= int.MaxValue)
                {
                    map[(int)pid] = new ProcessIdentity
                    {
                        Name = name ?? "",
                        CreateTicks = DateTime.FromFileTimeUtc(created).Ticks,
                        ParentPid = parent >= 0 && parent <= int.MaxValue ? (int)parent : 0
                    };
                }
                if (next == 0) break;
                offset += next;
            }
            return map;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static byte[] ReadBytes(SafeProcessHandle process, long address, int count)
    {
        if (address <= 0 || count <= 0 || count > 65534) throw new InvalidOperationException("进程内存信息无效。");
        var bytes = new byte[count];
        UIntPtr read;
        if (!ReadProcessMemory(process, new IntPtr(address), bytes, new UIntPtr((uint)count), out read))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (read.ToUInt64() != (ulong)count) throw new InvalidOperationException("进程内存读取不完整，请刷新。");
        return bytes;
    }

    static long Pointer(byte[] bytes, int offset, bool is32)
    {
        return is32 ? BitConverter.ToUInt32(bytes, offset) : BitConverter.ToInt64(bytes, offset);
    }

    // UNICODE_STRING：读取后复读一次描述符，内容中途变化时明确失败而不是返回截断文本。
    static string ReadUnicodeString(SafeProcessHandle process, long address, bool is32)
    {
        byte[] descriptor = ReadBytes(process, address, is32 ? 8 : 16);
        int length = BitConverter.ToUInt16(descriptor, 0);
        int maximum = BitConverter.ToUInt16(descriptor, 2);
        if (length == 0) return null;
        if (length % 2 != 0 || length > maximum || length > 65534)
            throw new InvalidOperationException("进程字符串长度无效。");
        byte[] value = ReadBytes(process, Pointer(descriptor, is32 ? 4 : 8, is32), length);
        byte[] current = ReadBytes(process, address, descriptor.Length);
        for (int i = 0; i < descriptor.Length; i++)
            if (current[i] != descriptor[i]) throw new InvalidOperationException("进程信息正在变化，请刷新。");
        string text = new UnicodeEncoding(false, false, true).GetString(value);
        if (text.IndexOf('\0') >= 0) throw new InvalidOperationException("进程字符串内容无效。");
        return text;
    }

    public static ProcessDetails Read(int pid, long expectedTicks)
    {
        if (IntPtr.Size != 8) throw new NotSupportedException("进程详情读取需要 64 位工具箱。");
        // 只申请查询和读内存权限；持有同一进程句柄并校验创建时间，防止 PID 复用。
        using (var process = OpenProcess(0x0400 | 0x0010, false, pid))
        {
            if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            long created, exited, kernel, user;
            if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (DateTime.FromFileTimeUtc(created).Ticks != expectedTicks)
                throw new InvalidOperationException("进程已变化，请刷新。");
            bool is32;
            if (!IsWow64Process(process, out is32)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var basic = new byte[is32 ? 8 : 48];
            int returned;
            int status = NtQueryInformationProcess(process, is32 ? 26 : 0, basic, basic.Length, out returned);
            if (status < 0) throw new InvalidOperationException("无法查询进程环境块：0x" + status.ToString("X8"));
            long peb = BitConverter.ToInt64(basic, is32 ? 0 : 8);
            // ponytail: Windows 内部 PEB / RTL_USER_PROCESS_PARAMETERS 布局不是稳定公共接口；当前覆盖 x64 / WOW64。
            // 系统布局变化时明确失败；未来有稳定系统 API 时替换这里，不能用 exe 目录冒充。
            // 布局依据：https://github.com/giampaolo/psutil/blob/master/psutil/arch/windows/peb.c
            long parameters = Pointer(ReadBytes(process, peb + (is32 ? 0x10 : 0x20), is32 ? 4 : 8), 0, is32);
            var details = new ProcessDetails();
            try
            {
                string directory = ReadUnicodeString(process, parameters + (is32 ? 0x24 : 0x38), is32);
                if (directory == null) throw new InvalidOperationException("工作目录长度无效。");
                if (!Path.IsPathRooted(directory)) throw new InvalidOperationException("工作目录内容无效。");
                details.WorkingDirectory = directory;
            }
            catch (Exception error) { details.WorkingDirectoryError = error.GetBaseException().Message; }
            try
            {
                string image = ReadUnicodeString(process, parameters + (is32 ? 0x38 : 0x60), is32);
                // 部分进程的映像路径写作 NT 设备路径，去掉 \??\ 前缀还原为常规路径。
                if (image != null && image.StartsWith("\\??\\")) image = image.Substring(4);
                if (string.IsNullOrEmpty(image)) image = null;
                details.ImagePath = image;
            }
            catch { }
            try { details.CommandLine = ReadUnicodeString(process, parameters + (is32 ? 0x40 : 0x70), is32); }
            catch { }
            return details;
        }
    }
}
