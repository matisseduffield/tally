# Opens a group link that does not exist: shows links reach the page and the page reaches the server.
xcrun simctl openurl "$ID" "tally://g/AAAAAAAAAAAAAAAAAAAAAA"
sleep 6
xcrun simctl io "$ID" screenshot shots/link.png
