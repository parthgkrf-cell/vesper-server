# Google Cloud Platform (GCP) — 24/7 Server Hosting Guide

This guide explains how to host the **Vesper Mail Scheduler** backend on **Google Cloud Platform (GCP)** so that your scheduled emails can be dispatched 24 hours a day, even when your personal computer is shut down.

---

## 🛑 Important: Why Google Drive Won't Work
Google Drive is a **static file storage and synchronization platform**. 
* It **cannot run active software** (like Python scripts or Node.js servers) in the background. 
* Hosting files on Google Drive requires a local system to be powered on to execute the files.
* To run Vesper 24/7, you **must** use an active cloud server, such as a **Google Cloud Virtual Machine (VM)**.

---

## 🚀 How to Host Vesper 24/7 on Google Cloud (Free Tier)

Google Cloud Platform offers an **"Always Free" Tier** which includes a free lightweight Virtual Machine (Compute Engine instance) that runs continuously. Follow these steps to host your Vesper relay server on it:

### Step 1: Set Up your GCP VM (Compute Engine)
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a free GCP account (new accounts get $300 in free credits).
3. Open the **Navigation Menu** (top-left) and go to **Compute Engine > VM Instances**.
4. Click **Create Instance**.
5. Configure the VM to stay within the **GCP Free Tier limits**:
   * **Region**: Select `us-central1` (Iowa), `us-east1` (South Carolina), or `us-west1` (Oregon).
   * **Machine Type**: Choose `e2-micro` (2 vCPUs, 1 GB memory). *This instance type is free!*
   * **Boot Disk**: Select **Ubuntu Linux (22.04 LTS or newer)**, Standard Persistent Disk, size **10 GB** or **30 GB** (free tier supports up to 30 GB).
   * **Firewall**: Check **Allow HTTP traffic** and **Allow HTTPS traffic**.
6. Click **Create** at the bottom.

### Step 2: Open Ports in the GCP Firewall
To allow the Vesper client in your browser to talk to your new VM server:
1. In the GCP Console, search for **VPC network firewall rules**.
2. Click **Create Firewall Rule**.
3. Set the following details:
   * **Name**: `allow-vesper`
   * **Targets**: Select *All instances in the network*.
   * **Source IPv4 ranges**: `0.0.0.0/0` (Allows connection from any browser client).
   * **Protocols and ports**: Check *Specified protocols and ports*, check *TCP*, and enter `3000` (or whichever port you choose to run Vesper on).
4. Click **Create**.

### Step 3: Install & Start the Server on your VM
1. On your **VM Instances** page in GCP, click the **SSH** button next to your new VM instance. A terminal window will open in your browser.
2. In the terminal, run the following commands to install Python 3 and download the repository:
   ```bash
   # Update system packages
   sudo apt update && sudo apt upgrade -y

   # Install git and python3-pip
   sudo apt install -y git python3 python3-pip
   ```
3. Upload or copy your `server.py` file to the VM. You can copy the code from your local machine and write it to a file:
   ```bash
   nano server.py
   # (Paste the contents of server.py from your machine, then press Ctrl+O, Enter, Ctrl+X to save)
   ```
4. Start the server in the background so it continues running even if you close the terminal window:
   ```bash
   # Run the server on port 3000 in the background using nohup
   nohup python3 server.py 3000 > server.log 2>&1 &
   ```
5. You can verify it is running by running: `cat server.log` or `ps aux | grep python`.

### Step 4: Configure the Vesper Web Client
1. Find your VM's **External IP Address** on the VM Instances page (e.g. `34.123.45.67`).
2. Open your Vesper client in your browser.
3. Go to the **Configuration** tab.
4. Update the **Helper Server URL** from `http://localhost:3000/send` to:
   `http://<YOUR_VM_EXTERNAL_IP>:3000/send` (e.g. `http://34.123.45.67:3000/send`).
5. Click **Test**. You should see **`Status: Connected (Server Active)`**!

Now, you can import, compose, and start your scheduler. Even if you shut down your personal laptop, the cloud server will process the queues, connect to Gmail via SMTP/IMAP, and send/draft your emails automatically.
