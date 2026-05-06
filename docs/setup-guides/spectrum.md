# Spectrum: Disable DHCP

Spectrum (Charter) ships modem-router combos under several brand
names — most often **Sagemcom**, **Askey**, or **Hitron**. The DHCP
setting lives in the same place across all of them.

> _Screenshot placeholder — Spectrum gateway login screen._

1. From a phone or laptop on the Spectrum Wi-Fi, open
   **http://192.168.1.1** in a browser.
2. Log in. The username is usually **admin**; the password is on a
   sticker on the gateway labeled "Admin password."
3. Click **Gateway**, then **Connection → Local IP Network**.

   > _Screenshot placeholder — Local IP Network page with DHCP toggle._

4. Find **DHCP Server** and switch it to **Disabled**.
5. Click **Save** at the bottom.
6. Open **http://meadow.local** and tap **Retry network setup**.

**If you can't log in:** Spectrum sometimes locks out the admin
panel for self-installed equipment. Call Spectrum support (1-833-267-6094)
and ask them to **enable bridge mode** on your gateway — that's
equivalent to disabling DHCP for our purposes. You'll typically
need a separate router for Wi-Fi after that, but if you have one
(an eero, ASUS, etc.), it can take over routing while Meadow handles
DNS.
