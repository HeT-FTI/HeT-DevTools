#include <gtest/gtest.h>
#include <thread>
#include <chrono>



int sleep(int n) {
    std::this_thread::sleep_for(std::chrono::seconds(n));
    return n + 1;
}



TEST(Stress, Sleep) {
    EXPECT_EQ(sleep(3), 4);
}