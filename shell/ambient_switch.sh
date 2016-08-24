#########################################################
# This script assumes the ambient service executable in
# /bin/als-controller is running. It gets the status and
# switches to the alternative. 
#########################################################
#!/bin/bash
SERVICE="/bin/als-controller"
IMAGES="~/usr/images"
STATUS=$("$SERVICE" -s)
if [ "$STATUS" = "0" ]; then
	"$SERVICE" -e
	notify-send -c "device" -i "$IMAGES/"'active.svg' 'Ambient Light Sensor' 'Enabled'
elif [ "$STATUS" = "1" ]; then
	"$SERVICE" -d
	notify-send -c "device" -i "$IMAGES/"'inactive.svg' 'Ambient Light Sensor' 'Disabled'
else
	echo "Error: $STATUS"
fi
