# Starts the app on a group link that does not exist: shows links reach the page and the page reaches the server.
xcrun simctl terminate "$ID" "com.matisseduffield.tally"
xcrun simctl launch "$ID" "com.matisseduffield.tally" -link "tally://g/AAAAAAAAAAAAAAAAAAAAAA"
sleep 8
xcrun simctl io "$ID" screenshot shots/link.png
