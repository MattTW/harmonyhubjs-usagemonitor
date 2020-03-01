var Q = require('q');
var nconf = require('nconf');
var harmony = require('harmonyhubjs-client');
var log = new require('simple-node-logger').createSimpleLogger();
var express = require('express'), app = express();
var moment = require('moment');
var mongoose = require('mongoose');
var CronJob = require('cron').CronJob;
var applescript = require("applescript");
var sprintf = require("sprintf-js").sprintf;

nconf.argv()
   .env()
   .file({ file: './config.json' });

var monitoredHub = nconf.get("monitoredHub");


//hack until mongoose save does promises
mongoose.Document.prototype.savePromise = function () {
    var that = this;
    return Q.Promise(function(resolve, reject) {
        that.save(function (err, item, numberAffected) {
            if (err) {
                reject(err);
            }
            resolve([item, numberAffected]);
        });
    });
};
mongoose.connect(nconf.get("mongoDBURL"));
var db = mongoose.connection;
db.on('error', function(err) { handleError(err)});
var activityDataSchema = mongoose.Schema({
	date: {type: Date, required: true},
	hub: {type: String, required: true},
	activities: {type: mongoose.Schema.Types.Mixed, required: true}
});
var ActivityData = mongoose.model('activityData', activityDataSchema);

log.setLevel(nconf.get("logLevel"));

function handleError(err) {
	log.error("Oops! Got an error: " + err);
}

function sendIMessage(theMessage) {
	var notifyUsers = nconf.get("notifyUsers");
	notifyUsers.forEach(function(currentUser) {
		var scriptArgs = [currentUser,theMessage]
		applescript.execFile("sendMessage.applescript",scriptArgs, function(err, rtn){
			if (err) {
				log.error("Error sending message.  Exit code was: " + err.exitCode);
			} else {
				log.info("Message Sent: " + theMessage);
				log.debug("Return data from applescript call was: " + rtn);
			}
		});
	});

}

function shutdownHubAndNotify() {
	sendIMessage("Maximum minutes reached.  System will be shut down.  Sorry about that!");
	return harmony(monitoredHub).then(function(harmonyClient) {
		harmonyClient.turnOff();
		harmonyClient.end();
	});
}

function getHubActivities() {
	var myActivities = {};
	log.debug('Connecting to hub to get all defined activities...');
	return harmony(monitoredHub).then(function(harmonyClient) {
		log.debug('Querying hub for all defined activities...');
		return harmonyClient.getActivities().then(function(activities) {
			activities.forEach(function(activity) {
				myActivities[activity.id] = {'name': activity.label, 'active': 0};
			});
			log.trace('Activity init complete: ' + JSON.stringify(myActivities));
			harmonyClient.end();
			return myActivities;
		});
	});
}


function saveActivityData(anActivityData) {
	log.debug('Saving activity record...');
	log.trace(JSON.stringify(anActivityData));
	return anActivityData.savePromise().then(function (productAndnumberAffectedArray) {
		log.debug('Activity record saved.  Number of records affected: ' + productAndnumberAffectedArray[1]);
		log.trace(JSON.stringify(productAndnumberAffectedArray[0]));
	//catch - mongoose promise doesn't support catch shorthand I guess
	}).then(undefined, function(err) {
		handleError(err);
	});
}

function updateActivityData(anActivityData) {
	return harmony(monitoredHub).then(function(harmonyClient) {
		log.debug('Connecting to harmony to get current activity...');
		return harmonyClient.getCurrentActivity().then(function(activity) {
			log.trace(JSON.stringify(anActivityData));
			log.debug('Current activity id is:' + activity);
			anActivityData['activities'][activity]['active']++;
			anActivityData.markModified('activities');
			log.trace(JSON.stringify(anActivityData));
			var totalActiveMinutes = 0
			for (activityId in anActivityData['activities']) {
				if (activityId == -1) continue;
				totalActiveMinutes += anActivityData['activities'][activityId]['active'];
			}
			log.info('Total activity minutes is now ' + totalActiveMinutes);
			var maxMinutes = nconf.get("maxMinutes");
			var warnPcts = nconf.get("warnPercentages");
			//send warnings if hit
			warnPcts.forEach(function(currentWarnPct) {
				if(Math.floor(maxMinutes * (currentWarnPct / 100)) == totalActiveMinutes) {
					sendIMessage(sprintf("Warning: system usage is at %i%%.  Current Minutes: %i   Maximum Minutes: %i",currentWarnPct,totalActiveMinutes,maxMinutes));
				}
			});
			//if we are at or over max and system is not in off state, turn it off now and send message
			if ((totalActiveMinutes >= maxMinutes) && (activity != -1)) {
				shutdownHubAndNotify();
			}
			harmonyClient.end();
			saveActivityData(anActivityData).then(function() {
				log.debug("Update of Activity Data complete");
			});
		});
	});
}

function loadOrCreateActivityData(when) {
	return ActivityData.findOne({ date: when }).exec().then(function (activityData) {
		if (!activityData) {
			log.debug('No activity record found for today, creating a new one...');
			return getHubActivities().then(function(activities) {
				var currentActivityData = new ActivityData({ date: when, hub: monitoredHub, activities: activities});
				return saveActivityData(currentActivityData).then(function() {
					return currentActivityData;
				});
			});
		} else {   //found existing activityData
			log.debug('Activity record found in database.')
			return activityData;
		};
	//catch - mongoose promise doesn't support catch shorthand I guess
	}).then(undefined, function(err) {
		handleError(err);
	});
}

function monitorHubActivity() {
	log.debug('Checking which activity is running...');
	var today = moment().startOf('day').toDate();
	loadOrCreateActivityData(today).then(function(activityData) {
		updateActivityData(activityData);
	});
}



db.once('open', function() {
	//once mongodb connection establislhed, check for activity every minute
	new CronJob('0 * * * * *', monitorHubActivity, null, true);
});



app.get('/', function(req, res) {
	var today = moment().startOf('day').toDate();
	loadOrCreateActivityData(today).then(function(activityData) {
		res.send(activityData);
	});
});
app.listen(nconf.get("webListenPort"));
log.info("Server running...")





