# Sounds

Sounds: [notificationsounds.com](https://notificationsounds.com/) ("Intuition" and "Accomplished", CC BY 4.0) and Pixabay ("UI Sounds Pack 3 – 15", "Bubble Pop 06").

Bot HQ plays four short sounds. The send click plays when the Owner sends a message. "Intuition" plays when an Agent's reply arrives. "Accomplished" plays
instead for the first reply of a turn that worked for 60 seconds or more, and later replies in that turn
stay quiet. The bubble pop plays when a tapback lands. Each comes as AAC (`.m4a`) with an MP3 fallback, 64 kbps mono, with
leading silence trimmed, a short fade, and a −6 dBFS peak (the send click and Intuition are used untrimmed, only made mono where needed and raised to that level). The app plays them at volume 0.35, only while
the tab is visible, and never with Reduce motion turned on.

| File | Plays on | Source | Author | Licence | Trim |
|---|---|---|---|---|---|
| `send/send` | Owner sends | Pixabay item 359713, "UI Sounds Pack 3 – 15" (from the download filename `47313572-ui-sounds-pack-3-15-359713.mp3`; the Owner downloaded it) | Pixabay uploader 47313572 | [Pixabay Content License](https://pixabay.com/service/license-summary/) | none (0.13 s) |
| `intuition/receive` | Agent reply | [Intuition](https://notificationsounds.com/notification-sounds/intuition-561) (the Owner's download) | NotificationSounds.com | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), credit required | none (0.38 s) |
| `accomplished/done` | Reply after 60 s+ of work | [Accomplished](https://notificationsounds.com/notification-sounds/accomplished-579) | NotificationSounds.com | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), credit required | 0.90 s |
| `bubble/pop` | Tapback | [Bubble Pop 06](https://pixabay.com/sound-effects/film-special-effects-bubble-pop-06-351337/) | Universfield | [Pixabay Content License](https://pixabay.com/service/license-summary/) | 0.18 s |

The credit also appears under Settings → Sounds. The Pixabay files must not be sold or redistributed on
their own, outside Bot HQ.
