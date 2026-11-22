# Sounds

Sounds: [notificationsounds.com](https://notificationsounds.com/) ("Hollow" and "Accomplished", CC BY 4.0) and Pixabay ("Bubble Pop 06").

Bot HQ plays three short sounds. "Hollow" plays when an Agent's reply arrives. "Accomplished" plays
instead for the first reply of a turn that worked for 60 seconds or more, and later replies in that turn
stay quiet. The bubble pop plays when a tapback lands. Sending is silent. Each comes as AAC (`.m4a`) with an MP3 fallback, 64 kbps mono, with
leading silence trimmed, a short fade, and a −6 dBFS peak. The app plays them at volume 0.35, only while
the tab is visible, and never with Reduce motion turned on.

| File | Plays on | Source | Author | Licence | Trim |
|---|---|---|---|---|---|
| `hollow/receive` | Agent reply | [Hollow](https://notificationsounds.com/sound-effects/hollow-582) | NotificationSounds.com | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), credit required | 0.75 s |
| `accomplished/done` | Reply after 60 s+ of work | [Accomplished](https://notificationsounds.com/notification-sounds/accomplished-579) | NotificationSounds.com | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), credit required | 0.90 s |
| `bubble/pop` | Tapback | [Bubble Pop 06](https://pixabay.com/sound-effects/film-special-effects-bubble-pop-06-351337/) | Universfield | [Pixabay Content License](https://pixabay.com/service/license-summary/) | 0.18 s |

The credit also appears under Settings → Sounds. The Pixabay file must not be sold or redistributed on
its own, outside Bot HQ.
