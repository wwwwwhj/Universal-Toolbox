using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class PortWorkingDirectory
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

    static byte[] ReadBytes(SafeProcessHandle process, long address, int count)
    {
        if (address <= 0 || count <= 0 || count > 65534) throw new InvalidOperationException("工作目录内存信息无效。");
        var bytes = new byte[count];
        UIntPtr read;
        if (!ReadProcessMemory(process, new IntPtr(address), bytes, new UIntPtr((uint)count), out read))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (read.ToUInt64() != (ulong)count) throw new InvalidOperationException("工作目录读取不完整，请刷新。");
        return bytes;
    }

    static long Pointer(byte[] bytes, int offset, bool is32)
    {
        return is32 ? BitConverter.ToUInt32(bytes, offset) : BitConverter.ToInt64(bytes, offset);
    }

    public static string Read(int pid, long expectedTicks)
    {
        if (IntPtr.Size != 8) throw new NotSupportedException("工作目录读取需要 64 位工具箱。");
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
            // ponytail: Windows 内部 PEB 布局不是稳定公共接口；当前覆盖 x64 / WOW64。
            // 系统布局变化时明确失败；未来有稳定系统 API 时替换这里，不能用 exe 目录冒充。
            // 布局依据：https://github.com/giampaolo/psutil/blob/master/psutil/arch/windows/peb.c
            long parameters = Pointer(ReadBytes(process, peb + (is32 ? 0x10 : 0x20), is32 ? 4 : 8), 0, is32);
            long descriptorAddress = parameters + (is32 ? 0x24 : 0x38);
            byte[] descriptor = ReadBytes(process, descriptorAddress, is32 ? 8 : 16);
            int length = BitConverter.ToUInt16(descriptor, 0);
            int maximum = BitConverter.ToUInt16(descriptor, 2);
            if (length == 0 || length % 2 != 0 || length > maximum)
                throw new InvalidOperationException("工作目录长度无效。");
            byte[] value = ReadBytes(process, Pointer(descriptor, is32 ? 4 : 8, is32), length);
            byte[] current = ReadBytes(process, descriptorAddress, descriptor.Length);
            for (int i = 0; i < descriptor.Length; i++)
                if (current[i] != descriptor[i]) throw new InvalidOperationException("工作目录正在变化，请刷新。");
            string path = new UnicodeEncoding(false, false, true).GetString(value);
            if (path.IndexOf('\0') >= 0 || !Path.IsPathRooted(path)) throw new InvalidOperationException("工作目录内容无效。");
            return path;
        }
    }
}
