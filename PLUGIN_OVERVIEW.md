## See which thread needs you

Thread card adds a Needs you queue to bb. Each card shows what a thread is about, what is done, and who takes the next step.

Reply opens the conversation. Remind me later moves the request aside until a chosen time. Archive sends the thread to bb's archive. New requests from a snoozed or hidden thread can appear again.

## Keep your place

Separate views show requests for you, waits on others, stopped work, and snoozed items. Group by section or project, search requests, and filter the list. New arrivals wait behind Show N updates while you read. The chat opens beside the queue on desktop and has a Back to list button on a phone.

A card in the thread header shows progress and title controls. Sidebar icons show the status without changing your titles.

## Reports and optional helpers

Working agents report their own status through report_thread_status. Status tracking uses these reports and bb's execution state.

An optional helper can read threads whose agents did not report. Automatic helpers are off by default. Manual rechecks also use the configured model and consume its tokens or subscription allowance. No separate service account is required.

## Requirements

Requires bb 0.43+ and Plugin SDK 0.5.9+. Checked on bb 0.43.4. Helper filesystem support targets Linux and macOS; Windows is unverified. By status sidebar sorting appears only when bb provides its optional sorting API.

Source, setup, CLI commands, data handling, and MIT license: https://github.com/merllinsbeard/bb-thread-card
