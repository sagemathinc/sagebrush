<?php
// Synthetic users and a course for the LTI tests (plan-lti-r5 §12): student1,
// teacher1, mentor1 (Mentor role is not standard in Moodle; non-editing teacher
// stands in for a TA), course LTI101.  Passwords come from the environment.
define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->libdir . '/enrollib.php');
$pw = getenv('SEED_PW');
function mkuser($u, $pw) {
    global $DB, $CFG;
    if ($x = $DB->get_record('user', ['username' => $u])) {
        update_internal_user_password($x, $pw);
        return $x->id;
    }
    return user_create_user((object)['username' => $u, 'password' => $pw, 'firstname' => $u, 'lastname' => 'Synthetic', 'email' => "$u@example.invalid", 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id]);
}
$ids = ['student1' => mkuser('student1', $pw), 'teacher1' => mkuser('teacher1', $pw), 'ta1' => mkuser('ta1', $pw)];
$c = $DB->get_record('course', ['shortname' => 'LTI101']);
if (!$c) $c = create_course((object)['fullname' => 'LTI test course (synthetic)', 'shortname' => 'LTI101', 'category' => 1]);
$enrol = enrol_get_plugin('manual');
$inst = $DB->get_record('enrol', ['courseid' => $c->id, 'enrol' => 'manual']);
$role = fn($s) => $DB->get_field('role', 'id', ['shortname' => $s]);
$enrol->enrol_user($inst, $ids['student1'], $role('student'));
$enrol->enrol_user($inst, $ids['teacher1'], $role('editingteacher'));
$enrol->enrol_user($inst, $ids['ta1'], $role('teacher'));
echo json_encode(['course' => (int)$c->id]), "\n";
