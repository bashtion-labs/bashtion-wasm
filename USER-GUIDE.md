# bashtion — User Guide

bashtion is a real Linux computer that runs inside a web browser tab. You do not install
anything. You do not make an account. You just open a page, and a full Linux system starts up
for you to use.

This guide shows you how to use it.

## What you need

- A web browser. Google Chrome or Microsoft Edge work best.
- That's it. Everything runs in the browser tab.

If the page says your browser is not supported, try Chrome or Edge and make sure it is
up to date.

## Starting up

1. Open the page.
2. You will see the bashtion logo and the words "starting your environment."
3. Wait a little. The first start takes a minute or two. This is normal.
4. When it is ready, the logo goes away and you see a black screen with green or white text.
   The last line looks like this:

   ```
   user@bashtion:~$
   ```

That last line is called the **prompt**. It means Linux is ready and waiting for you to type.

## Typing commands

Click once on the black area so the page knows you want to type there. Then type a command
and press **Enter**.

Try this one:

```
ls
```

That lists the files in your folder. Here are a few more safe ones to try:

- `pwd` — shows which folder you are in
- `whoami` — shows your user name (it will say `user`)
- `date` — shows the time and date
- `uname -a` — shows details about the Linux system

**A note about speed:** Linux here runs a little slower than a normal computer. Some commands
take a few seconds to finish. If nothing happens right away, wait a moment before trying again.
It is working.

**Reading the manual.** Every command has a manual page. Type `man ls` to read about `ls`, and
press `q` to leave it. `man -k disk` searches for commands about a topic. This works with no
internet, because the manuals are already on the machine.

## Using admin commands

Some commands need admin power. In Linux, you get that by putting the word `sudo` in front of
the command. For example:

```
sudo lsblk
```

On a normal computer, `sudo` asks for a password. Here it does not — you can just use it. This
keeps things simple.

## Saving your work

Your work is **not** saved automatically. If you close the tab without saving, your files are
gone. So save before you leave.

There are two buttons at the top of the page:

### Download my work

Click **Download my work**. A small window shows the progress. When it is done, a file is
saved to your computer's Downloads folder. The file name looks like:

```
bashtion-work-2026-08-30.tgz
```

Keep this file somewhere safe. This is the copy you can always trust. It works even if you use
a different computer next time, or if the browser forgets its data.

### Load work

Next time you come back:

- **Load work** brings back the copy this browser remembers. If the browser has no copy, it
  asks you for a file instead.
- **Load from a file...** always asks you for a file — use this one for a file you downloaded,
  or on a different computer.

A window shows the progress, and then your files are back.

**Best habit:** Always use **Download my work** and keep the file. It is the safe way. The
browser's own memory can be erased, especially on shared or managed computers.

### What gets saved

Your home folder, and any changes you made to system settings — files you edited in `/etc`,
users and groups you created, cron jobs you set up, folders you made in `/opt`. Anything you
deleted stays deleted.

**Programs you installed with `apt install` are not saved.** They are too big to travel the
way saving works here. If you need one after loading your work back, install it again — it
takes a moment and needs no internet.

## Things to know

- **No internet inside.** bashtion cannot reach websites on the internet. `ping 8.8.8.8` will
  not work, and that is expected. But `ping 127.0.0.1` (talking to itself) does work.
- **Installing programs.** You can install some programs with `sudo apt install`, but only the
  ones that were packed in ahead of time. It will not download new ones from the internet.
  Try `sudo apt install tree` to see it work.
- **A spare disk.** There is a second, empty 1 GB disk called `/dev/vdb`. Use it for anything
  large, and for practising with partitions and filesystems. The main disk is small.
- **The window size.** The screen fits your browser window. If you make the window bigger, you
  get more room. `stty size` tells you how many rows and columns you have.
- **It's your own computer.** Anything you do only affects your browser tab. You cannot break
  anyone else's system, and you cannot harm your real computer. If something goes wrong, just
  reload the page and start fresh.

## Quick fixes

**The screen is blank for a long time after the logo.**
Wait up to a few minutes on the first start. The system is booting behind the logo. If it is
still blank after that, reload the page.

**I clicked Download my work and it says "wait for the $ prompt."**
The system was not fully ready yet. Wait until you see the `user@bashtion:~$` prompt, then
click the button again.

**My typing does nothing.**
Click once on the black screen first, then type. The page needs to know you are typing there.

**Everything is very slow.**
That is normal. This is a whole Linux computer running inside your browser. Give commands a few
seconds to finish.

**Saving or loading is taking a long time.**
The progress bar is moving, so it is working. Everything has to travel through a slow
connection between the page and the Linux system, so a lot of files take a while. If something
really does go wrong, the window tells you — it does not just sit there.

**The clock looks wrong.**
It is set from your computer's clock when the session starts. If you leave the tab for a long
time it can drift; `sudo date -s "..."` sets it again.

**I lost my files.**
If you did not download them, they are gone — reload and start again. Next time, use
**Download my work** before you close the tab.
