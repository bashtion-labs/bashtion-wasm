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

Next time you come back, click **Load work** to bring your files back.

- If you have your downloaded file, pick it when the page asks.
- If you are on the same computer and same browser as last time, you can click **Load work**
  and it may find your last save on its own.

A window shows the progress, and then your files are back.

**Best habit:** Always use **Download my work** and keep the file. It is the safe way. The
browser's own memory can be erased, especially on shared or managed computers.

## Things to know

- **No internet inside.** bashtion cannot reach websites on the internet. `ping 8.8.8.8` will
  not work, and that is expected. But `ping 127.0.0.1` (talking to itself) does work.
- **Installing programs.** You can install some programs with `sudo apt install`, but only the
  ones that were packed in ahead of time. It will not download new ones from the internet.
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

**I lost my files.**
If you did not download them, they are gone — reload and start again. Next time, use
**Download my work** before you close the tab.
