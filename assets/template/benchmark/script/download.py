#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys
import shutil
import tempfile


def run(cmd):
    print(">>", " ".join(cmd))
    subprocess.run(cmd, check=True)


def require_tool(tool_name):
    if shutil.which(tool_name) is None:
        print(f"未找到命令: {tool_name}，请先安装后再试")
        sys.exit(1)

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--binary", required=True, help="local binary/ELF path")
    p.add_argument("--remote", default="/tmp/main", help="target path on the board")
    p.add_argument("--mode", choices=["adb", "ssh", "openocd", "pyocd", "jlink"], required=True)
    p.add_argument("--host", help="ssh destination, e.g. root@192.168.77.2")
    p.add_argument("--run", action="store_true", help="execute right after transferring")
    p.add_argument("--addr", default="0x08000000", help="MCU flash start address (usual for .bin)")
    p.add_argument("--interface", default="interface/stlink.cfg", help="openocd interface config")
    p.add_argument("--target", help="openocd target cfg (required in openocd mode) or pyocd target name")
    p.add_argument("--transport", choices=["swd", "jtag"], default="swd", help="openocd transport (default swd)")
    p.add_argument("--probe", help="pyocd probe id (e.g. 69613170 or jlink:69613170)")
    p.add_argument("--device", help="J-Link device name (required in jlink mode), e.g. BAT32G157GK64FB")
    p.add_argument("--speed", default="4000", help="J-Link interface speed in kHz, default 4000")
    p.add_argument("--no-verify", action="store_true", help="skip verify after flashing the MCU")
    p.add_argument("--cmsis-vid-pid", help="VID:PID of a non-standard CMSIS-DAP probe (e.g. WCH-Link), format 0x1a86:0x8012")
    args = p.parse_args()

    if not os.path.isfile(args.binary):
        print(f"二进制不存在: {args.binary}")
        sys.exit(1)

    if args.mode == "adb":
        run(["adb", "devices"])
        run(["adb", "push", args.binary, args.remote])
        run(["adb", "shell", "chmod", "+x", args.remote])
        if args.run:
            run(["adb", "shell", args.remote])

    elif args.mode == "ssh":
        if not args.host:
            print("--host is required in ssh mode, e.g. root@192.168.77.2")
            sys.exit(1)
        run(["scp", args.binary, f"{args.host}:{args.remote}"])
        run(["ssh", args.host, "chmod", "+x", args.remote])
        if args.run:
            run(["ssh", args.host, args.remote])

    elif args.mode == "openocd":
        if not args.target:
            print("--target is required in openocd mode, e.g. target/stm32f4x.cfg")
            sys.exit(1)
        require_tool("openocd")

        verify_part = "" if args.no_verify else " verify"
        ext = os.path.splitext(args.binary)[1].lower()
        if ext in (".bin", ".img"):
            program_cmd = f"program {args.binary} {args.addr}{verify_part} reset exit"
        else:
            # openocd derives the address for ELF/HEX from the file metadata
            program_cmd = f"program {args.binary}{verify_part} reset exit"

        # ST-Link needs the HLA prefix (hla_swd/hla_jtag); passing swd/jtag too errors
        transport = args.transport
        if "stlink" in args.interface.lower():
            transport = f"hla_{args.transport}"

        cmd = ["openocd", "-f", args.interface]
        if args.cmsis_vid_pid:
            # Non-ARM VID/PID probes are not in openocd's allow-list; an explicit entry is required
            vid, pid = args.cmsis_vid_pid.split(":")
            cmd += ["-c", f"cmsis_dap_vid_pid {vid} {pid}"]
        cmd += [
            "-f", args.target,
            "-c", f"transport select {transport}",
            "-c", "init",
            "-c", "halt",
            "-c", program_cmd,
        ]
        run(cmd)

    elif args.mode == "pyocd":
        if not args.target:
            print("--target is required in pyocd mode, e.g. stm32f407vg")
            sys.exit(1)
        require_tool("pyocd")

        # J-Link CE + pyocd can fail with open(serial) when non_interactive=true
        cmd = [sys.executable, "-m", "pyocd", "flash", args.binary, "-t", args.target,
               "-O", "jlink.non_interactive=false"]
        if args.probe:
            cmd.extend(["-u", args.probe])
        ext = os.path.splitext(args.binary)[1].lower()
        if ext in (".bin", ".img"):
            cmd.extend(["-a", args.addr])
        if args.no_verify:
            cmd.append("--no-verify")
        run(cmd)

    elif args.mode == "jlink":
        if not args.device:
            print("--device is required in jlink mode, e.g. BAT32G157GK64FB")
            sys.exit(1)

        jlink_exe = shutil.which("JLinkExe")
        if jlink_exe is None:
            print("command not found: JLinkExe -- install the SEGGER J-Link package first")
            sys.exit(1)

        ext = os.path.splitext(args.binary)[1].lower()
        jlink_binary_path = args.binary
        temp_bin_path = None

        # J-Link Commander ignores extensions like .img; convert to a temporary .bin
        if ext == ".img":
            with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f_bin:
                temp_bin_path = f_bin.name
            shutil.copyfile(args.binary, temp_bin_path)
            jlink_binary_path = temp_bin_path

        if ext in (".bin", ".img"):
            load_cmd = f"loadfile {jlink_binary_path} {args.addr}"
            verify_cmd = f"verifybin {jlink_binary_path} {args.addr}"
        else:
            # HEX/ELF/AXF carry their own addresses; loadfile already verifies
            load_cmd = f"loadfile {args.binary}"
            verify_cmd = None

        script_lines = [
            "r",
            "h",
            load_cmd,
        ]
        if (not args.no_verify) and verify_cmd:
            script_lines.append(verify_cmd)
        script_lines.append("r")
        if args.run:
            script_lines.append("g")
        script_lines.append("q")

        with tempfile.NamedTemporaryFile(mode="w", suffix=".jlink", delete=False) as f:
            script_path = f.name
            f.write("\n".join(script_lines) + "\n")

        try:
            cmd = [
                jlink_exe,
                "-device", args.device,
                "-if", args.transport.upper(),
                "-speed", str(args.speed),
                "-CommanderScript", script_path,
                "-ExitOnError", "1",
            ]
            if args.probe:
                probe = args.probe
                if probe.startswith("jlink:"):
                    probe = probe.split(":", 1)[1]
                cmd.extend(["-SelectEmuBySN", probe])
            run(cmd)
        finally:
            try:
                os.remove(script_path)
            except OSError:
                pass
            if temp_bin_path:
                try:
                    os.remove(temp_bin_path)
                except OSError:
                    pass


if __name__ == "__main__":
    main()
