# Disable DHCP on your router

Your Meadow box hands out IP addresses on your network so it can act
as the DNS filter for everyone in your home. Most home routers also
hand out IP addresses by default — that means there are two computers
trying to do the same job, and neither will work right.

**Good news: this only takes a few minutes, and you only do it once.**

Pick the guide for your router below. If you're not sure which one
you have, look on the back or bottom of the device for a brand and
model number.

## Wi-Fi routers

- [Netgear](./netgear.md)
- [ASUS](./asus.md)
- [TP-Link](./tp-link.md)
- [Linksys](./linksys.md)
- [eero](./eero.md)
- [Google Wifi / Nest Wifi](./google-wifi.md)

## Internet provider modems / gateways

These are devices your internet company gave you, often called a
"gateway" or "modem-router combo."

- [Spectrum](./spectrum.md)
- [Xfinity](./xfinity.md)
- [AT&T](./att.md)

## What if my router isn't listed?

The setting is usually called **DHCP server** or **LAN settings**, and
it's almost always under the router's network or LAN configuration
page. Look for a switch or checkbox to turn it off, then save the
change. Your router will keep handling Wi-Fi and the internet — the
only thing you're changing is who hands out IP addresses.

If you get stuck, email **support@dqsec.com** with your router brand
and model and we'll walk you through it.

## After you disable DHCP

Come back to **http://meadow.local** on your phone and tap **Retry
network setup**. Your box will run the check again and start handing
out addresses on your network.
