<?php
// Activate the dynamically registered Sagebrush tool (it arrives pending) and
// add one activity using it to LTI101, embedded or in a new window.
// Usage: php moodle-activity.php <embed|window>
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
\core\session\manager::set_user(get_admin());
$mode = $argv[1] ?? 'embed';
$type = $DB->get_record_sql("SELECT * FROM {lti_types} WHERE baseurl LIKE ? ORDER BY id DESC", ['%lti.vmtest%'], IGNORE_MULTIPLE);
if (!$type) { fwrite(STDERR, "no Sagebrush tool type\n"); exit(2); }
$DB->set_field('lti_types', 'state', LTI_TOOL_STATE_CONFIGURED, ['id' => $type->id]);
$c = $DB->get_record('course', ['shortname' => 'LTI101'], '*', MUST_EXIST);
$name = 'Sagebrush test (' . $mode . ')';
$existing = $DB->get_record('lti', ['course' => $c->id, 'name' => $name]);
if ($existing) {
    $cm = get_coursemodule_from_instance('lti', $existing->id, $c->id);
    echo json_encode(['cmid' => (int)$cm->id, 'typeid' => (int)$type->id]), "\n";
    exit(0);
}
$mi = (object)[
    'modulename' => 'lti', 'course' => $c->id, 'section' => 0, 'visible' => 1, 'name' => $name,
    'typeid' => $type->id, 'toolurl' => '', 'securetoolurl' => '',
    'launchcontainer' => $mode === 'window' ? LTI_LAUNCH_CONTAINER_WINDOW : LTI_LAUNCH_CONTAINER_EMBED,
    'instructorchoicesendname' => 0, 'instructorchoicesendemailaddr' => 0, 'instructorchoiceacceptgrades' => 0,
    'instructorchoiceallowroster' => 0, 'grade' => 0, 'cmidnumber' => '', 'showtitlelaunch' => 1, 'showdescriptionlaunch' => 0,
    'introeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
];
$cm = create_module($mi);
echo json_encode(['cmid' => (int)$cm->coursemodule, 'typeid' => (int)$type->id]), "\n";
