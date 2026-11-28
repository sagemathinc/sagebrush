# Synthetic users and a course for the LTI tests on Canvas (plan-lti-r5 §12).
#   rails runner canvas-seed.rb            users + course + enrollments
#   rails runner canvas-seed.rb activate   turn on the newest Sagebrush registration's key, binding and deployment
pw = ENV.fetch("SEED_PW")
account = Account.default
if ARGV[0] == "activate"
  tool = ContextExternalTool.where(context: account).where("url LIKE ? OR domain LIKE ?", "%lti.vmtest%", "%lti.vmtest%").order(:id).last
  raise "no Sagebrush deployment" unless tool
  key = tool.developer_key
  key.update!(workflow_state: "active")
  DeveloperKeyAccountBinding.find_or_initialize_by(account:, developer_key: key).tap { |b| b.workflow_state = "on"; b.save! }
  tool.update!(workflow_state: "public")
  # course navigation, so a course launch exists without an assignment
  tool.settings[:course_navigation] = { enabled: true, text: "Sagebrush", visibility: "public" }
  tool.save!
  puts({ tool_id: tool.id, client_id: key.global_id.to_s, deployment_id: tool.deployment_id }.to_json)
  exit 0
end
def mkuser(name, pw, account)
  p = Pseudonym.active.find_by(unique_id: "#{name}@example.invalid")
  if p
    p.password = pw
    p.password_confirmation = pw
    p.save!
    return p.user
  end
  u = User.create!(name: "#{name} Synthetic")
  u.pseudonyms.create!(unique_id: "#{name}@example.invalid", password: pw, password_confirmation: pw, account:)
  u.register!
  u
end
student = mkuser("student1", pw, account)
teacher = mkuser("teacher1", pw, account)
course = Course.find_by(course_code: "LTI101") || account.courses.create!(name: "LTI test course (synthetic)", course_code: "LTI101")
course.offer! unless course.available?
course.enroll_student(student, enrollment_state: "active") unless course.student_enrollments.where(user: student).exists?
course.enroll_teacher(teacher, enrollment_state: "active") unless course.teacher_enrollments.where(user: teacher).exists?
puts({ course_id: course.id }.to_json)
