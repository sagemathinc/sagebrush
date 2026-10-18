//! A separate process per request permits a real per-field deadline.
fn main() {
    let request = std::env::args().nth(1).expect("one JSON request");
    println!("{}", sagebrush_web::call(&request));
}
