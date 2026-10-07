fn main() {
    // 234446a1 = [1, -1, 0, -79, 289]: b2 = -3, b4 = -158, b6 = 1156
    for (r, s) in [(197_000u64, 444u64), (197_000, 44), (1_000, 444), (5_000, 444)] {
        let t = std::time::Instant::now();
        let xs = sagebrush_ap::search::x_coordinates(-3, -158, 1156, r, s, 1_000_000).unwrap();
        println!("rmax {} smax {}: {} in {:?}", r, s, xs.len(), t.elapsed());
    }
}
